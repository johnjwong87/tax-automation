import { NextRequest, NextResponse } from "next/server";
import { analyzeRentalDocuments } from "@/lib/gemini";
import mammoth from "mammoth";
import MsgReader from "@kenjiuno/msgreader";

import * as XLSX from "xlsx";

export const maxDuration = 60; // Increase to 60 seconds for large uploads
export const dynamic = 'force-dynamic';

// Helper to convert ArrayBuffer to Buffer
function toBuffer(arrayBuffer: ArrayBuffer) {
    const buffer = Buffer.alloc(arrayBuffer.byteLength);
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < buffer.length; ++i) {
        buffer[i] = view[i];
    }
    return buffer;
}

// Helper to identify MIME type from filename/content
// Helper to identify MIME type from filename/content
function getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "pdf": return "application/pdf";
        case "png": return "image/png";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "doc": return "application/msword";
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "xls": return "application/vnd.ms-excel";
        case "csv": return "text/csv";
        case "msg": return "application/vnd.ms-outlook";
        case "txt": return "text/plain";
        default: return "application/octet-stream";
    }
}

const SUPPORTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "docx", "doc", "xlsx", "xls", "csv", "msg", "txt"];
const IGNORED_FILES = [".ds_store", "thumbs.db", "desktop.ini"];

function isSupportedFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase();
    const name = filename.split(/[\/\\]/).pop()?.toLowerCase();
    if (!ext || !name) return false;
    if (IGNORED_FILES.includes(name)) return false;
    return SUPPORTED_EXTENSIONS.includes(ext);
}

async function processFile(
    file: File | { name: string, arrayBuffer: () => Promise<ArrayBuffer> },
    manifest: string[],
    parentPath: string = ""
): Promise<any[]> {
    const normalizedName = file.name.replace(/\\/g, "/");

    if (!isSupportedFile(normalizedName)) {
        console.log(`Skipping unsupported/system file: ${normalizedName}`);
        return [];
    }

    const buffer = toBuffer(await file.arrayBuffer());

    // Prevent processing massive files that aren't PDFs/Images (e.g. huge CSVs)
    if (buffer.length > 10 * 1024 * 1024) { // 10MB limit per file
        console.warn(`File ${normalizedName} is too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB), skipping.`);
        return [];
    }

    const mimeType = ("type" in file) ? file.type : getMimeType(normalizedName);
    const parts = [];

    const currentPath = parentPath ? `${parentPath} > ${normalizedName}` : normalizedName;
    manifest.push(currentPath);

    if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        parts.push({
            inlineData: {
                data: buffer.toString("base64"),
                mimeType: mimeType,
            },
        });
        // Add a text label so Gemini knows which file this binary data belongs to
        parts.push({
            inlineData: {
                data: Buffer.from(`[BINARY FILE: ${currentPath}]`).toString("base64"),
                mimeType: "text/plain",
            }
        });
    } else if (
        mimeType.includes("spreadsheet") ||
        mimeType.includes("excel") ||
        mimeType === "text/csv"
    ) {
        // Parse Excel/CSV to Text
        try {
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            let allText = "";
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                allText += `\nSheet: ${sheetName}\n${csv}\n`;
            });
            parts.push({
                inlineData: {
                    data: Buffer.from(`FILE CONTENT (${currentPath}):\n${allText}`).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        } catch (err) {
            console.error(`Failed to parse spreadsheet ${normalizedName}`, err);
        }
    } else if (
        mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
        const { value: text } = await mammoth.extractRawText({ buffer });
        parts.push({
            inlineData: {
                data: Buffer.from(`FILE CONTENT (${currentPath}):\n${text}`).toString("base64"),
                mimeType: "text/plain",
            },
        });
    } else if (normalizedName.endsWith(".msg") || mimeType === "application/vnd.ms-outlook") {
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        const msgReader = new MsgReader(arrayBuffer);
        const fileData = msgReader.getFileData();

        // 1. Add Email Headers and Body
        const headerInfo = `
[EMAIL METADATA]
From: ${fileData.senderName} <${fileData.senderEmail}>
To: ${fileData.recipients?.map(r => `${r.name} <${r.email}>`).join("; ")}
Subject: ${fileData.subject}
`.trim();

        if (fileData.body || headerInfo) {
            parts.push({
                inlineData: {
                    data: Buffer.from(`${headerInfo}\n\n[BODY]\n${fileData.body || ""}`).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        }

        // 2. Process Attachments
        if (fileData.attachments && fileData.attachments.length > 0) {
            for (const attach of fileData.attachments) {
                try {
                    const attachData = msgReader.getAttachment(attach);
                    if (attachData) {
                        const attachName = (attachData.fileName || "unnamed_attachment").replace(/\\/g, "/");
                        console.log(`[MSG] found attachment: ${attachName} in ${normalizedName}`);
                        const attachContent = Buffer.from(attachData.content);

                        // Recursively process this attachment as if it were a file
                        // We create a "virtual file" object
                        const virtualFile = {
                            name: attachName,
                            arrayBuffer: async () => attachContent.buffer as ArrayBuffer
                        };

                        // Add context marker for the attachment
                        parts.push({
                            inlineData: {
                                data: Buffer.from(`[ATTACHMENT: ${attachName} found in ${normalizedName}]`).toString("base64"),
                                mimeType: "text/plain",
                            }
                        });

                        const childParts = await processFile(virtualFile, manifest, currentPath);
                        parts.push(...childParts);
                    }
                } catch (e) {
                    console.error(`Failed to process attachment in ${normalizedName}`, e);
                }
            }
        }
    } else {
        const text = buffer.toString("utf-8");
        parts.push({
            inlineData: {
                data: Buffer.from(text).toString("base64"),
                mimeType: "text/plain",
            },
        });
    }
    return parts;
}

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();

        // Get files from the distinct sections
        const filesPrior = formData.getAll("files_prior") as File[];
        const filesT776 = formData.getAll("files_t776") as File[];
        const filesCurrent = formData.getAll("files_current") as File[];

        let totalSize = 0;
        [...filesPrior, ...filesT776, ...filesCurrent].forEach(f => totalSize += f.size);
        console.log(`Processing Request:
      - Prior Files: ${filesPrior.length}
      - T776 Files: ${filesT776.length}
      - Current Files: ${filesCurrent.length}
      - Total Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB
    `);

        if (!filesCurrent || filesCurrent.length === 0) {
            return NextResponse.json(
                { error: "Current year files are required." },
                { status: 400 }
            );
        }

        const geminiParts = [];
        const manifest: string[] = [];

        // Helper to inject section headers
        const addSectionHeader = (header: string) => {
            geminiParts.push({
                inlineData: {
                    data: Buffer.from(`\n\n=== ${header} ===\n\n`).toString("base64"),
                    mimeType: "text/plain",
                }
            });
        };

        // 1. Process Prior Year Files (Context)
        if (filesPrior.length > 0) {
            addSectionHeader("SECTION: PRIOR YEAR FILES (SAMPLE)");
            for (const file of filesPrior) {
                const parts = await processFile(file, manifest, "PRIOR");
                geminiParts.push(...parts);
            }
        }

        // 2. Process Prior Year T776 (Template)
        if (filesT776.length > 0) {
            addSectionHeader("SECTION: PRIOR YEAR T776 (TEMPLATE)");
            for (const file of filesT776) {
                const parts = await processFile(file, manifest, "TEMPLATE");
                geminiParts.push(...parts);
            }
        }

        // 3. Process Current Year Files (Target)
        addSectionHeader("SECTION: CURRENT YEAR FILES (2024)");
        for (const file of filesCurrent) {
            const parts = await processFile(file, manifest, "");
            geminiParts.push(...parts);
        }

        // Enhanced Prompt
        const prompt = `
      You are an expert tax assistant specializing in Canadian Personal Income Tax (T776).
      
      You have been provided with documents in three potential sections:
      1. PRIOR YEAR FILES: Sample Context (ignore values, use for context only).
      2. PRIOR YEAR T776: The "Gold Standard" or Template. Use the categories, property names, and addresses found here as the canonical structure.
      3. CURRENT YEAR FILES: The receipts, bank statements, and invoices for the CURRENT tax year.
      
      **YOUR GOAL**:
      Create a T776 Statement of Real Estate Rentals for the **CURRENT YEAR FILES**.
      
      **INSTRUCTIONS**:
      - Use the properties found in "PRIOR YEAR T776" as the master list. If a property in Current Year Files matches one in Prior T776 (even vaguely), map it to the Prior T776 address.
      - Map expenses in Current Year Files to the same standard T776 categories used in the Prior Year T776.
      
      **CRITICAL EXTRACTION & AUDIT RULES**:
      1. **FORCEFUL EXTRACTION**: You MUST extract every expense or income item mentioned in the **email body text** (e.g., "I spent $300 on landscaping last week"). 
      2. **NO RECEIPT? NO PROBLEM**: Even if there is no matching PDF/image receipt, **the email text itself is the evidence**. Do NOT omit these items.
      3. **SOURCE ATTRIBUTION**: 
         - For items found directly in an email's text, set "source_file" to the filename of the .msg file.
         - For items in an attachment, use the path format "Email.msg > Attachment.pdf".
      4. **NOTES**: If an item is found only in an email body, add "Extracted from email body sentiment/text" to the property notes.
      
      **Special Rules for Client Communication**:
      - **STAFF IDENTITY**: Anyone with @stevenchong.com or @johnwong.ca is STAFF.
      - **CLIENT IDENTITY**: Match the names in the email chains against the **Taxpayer Name** on the "PRIOR YEAR T776". The draft email must be addressed TO this taxpayer.
      - **IDENTIFYING MISSING INFO**: Compare Current Year items against the Prior Year categories. If a recurring expense is missing, list it in the "notes" and include a request in the email draft.
      
      **OUTPUT**:
      Provide a JSON object with this structure:
      {
        "tax_year": number, 
        "properties": [
          {
            "address": "string (canonical address from Prior T776 if matched)",
            "income": { 
                "category_name": { "amount": number, "source_file": "string (FULL RELATIVE PATH including folder names)" } 
            },
            "income_prior": { "category_name": number },
            "expenses": { 
                "category_name": { "amount": number, "source_file": "string (FULL RELATIVE PATH including folder names)" } 
            },
            "expenses_prior": { "category_name": number },
            "source_files_read": ["string (FULL PATHS of files read)"],
            "notes": "string (Identify missing info, or note if a new property was found not in Prior T776)"
          }
        ],
        "email_draft": "string",
        "all_files_detected": ["string (all files you saw in the input)"]
      }
    `;

        const responseText = await analyzeRentalDocuments(prompt, geminiParts);

        if (!responseText || responseText.trim() === "") {
            return NextResponse.json({ error: "Empty response from AI" }, { status: 500 });
        }

        // Robust cleanup of markdown or chatter if JSON mode fails
        let cleanedResult = responseText.trim();
        if (cleanedResult.includes("{")) {
            // If there's conversational filler, find the first '{' and last '}'
            const start = cleanedResult.indexOf("{");
            const end = cleanedResult.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                cleanedResult = cleanedResult.substring(start, end + 1);
            }
        }

        let data;
        try {
            data = JSON.parse(cleanedResult);
        } catch (e) {
            console.error("Failed to parse Gemini JSON:", cleanedResult);
            return NextResponse.json({
                error: "The AI returned an invalid response. Please try re-sending with slightly fewer files.",
                raw: cleanedResult.substring(0, 500)
            }, { status: 500 });
        }

        // Overwrite Gemini's list with our reliable manifest from the recursive read
        data.all_files_detected = manifest;

        return NextResponse.json({ data });

    } catch (error: any) {
        console.error("Analysis error:", error);
        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
