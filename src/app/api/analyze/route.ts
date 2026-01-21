import { NextRequest, NextResponse } from "next/server";
import { analyzeRentalDocuments } from "@/lib/gemini";
import { del } from "@vercel/blob";
import mammoth from "mammoth";
import MsgReader from "@kenjiuno/msgreader";
import * as XLSX from "xlsx";

export const maxDuration = 60;
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
function getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "pdf": return "application/pdf";
        case "png": return "image/png";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "msg": return "application/vnd.ms-outlook";
        case "xlsx":
        case "xls": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "csv": return "text/csv";
        default: return "application/octet-stream";
    }
}

// Helper to check if file should be skipped
function shouldSkipFile(filename: string): boolean {
    const skipPatterns = [
        /^\./, // Hidden files
        /^~\$/, // Temp files
        /\.tmp$/i,
        /\.DS_Store$/i,
        /Thumbs\.db$/i,
    ];
    return skipPatterns.some(pattern => pattern.test(filename));
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

// Recursive file processor
async function processFile(
    fileBuffer: Buffer,
    filename: string,
    manifest: string[],
    currentPath: string
): Promise<{ inlineData: { data: string; mimeType: string } }[]> {
    const normalizedName = currentPath || filename;

    if (shouldSkipFile(filename)) {
        console.log(`Skipping file: ${normalizedName}`);
        return [];
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
        console.log(`File too large, skipping: ${normalizedName}`);
        return [];
    }

    manifest.push(normalizedName);
    const parts: { inlineData: { data: string; mimeType: string } }[] = [];
    const mimeType = getMimeType(filename);

    try {
        if (filename.endsWith(".msg")) {
            // Convert Node.js Buffer to ArrayBuffer for MsgReader
            const arrayBuffer = fileBuffer.buffer.slice(
                fileBuffer.byteOffset,
                fileBuffer.byteOffset + fileBuffer.byteLength
            );
            const msgReader = new MsgReader(arrayBuffer as ArrayBuffer);
            const fileData = msgReader.getFileData();

            let emailText = `--- EMAIL: ${normalizedName} ---\n`;
            if (fileData.headers) {
                emailText += `From: ${fileData.senderName || fileData.senderEmail || "Unknown"}\n`;
                emailText += `To: ${fileData.recipients?.map((r: any) => r.name || r.email).join(", ") || "Unknown"}\n`;
                emailText += `Subject: ${fileData.subject || "No Subject"}\n`;
            }
            emailText += `\nBody:\n${fileData.body || "(No body text)"}\n`;

            parts.push({
                inlineData: {
                    data: Buffer.from(emailText).toString("base64"),
                    mimeType: "text/plain",
                },
            });

            if (fileData.attachments && fileData.attachments.length > 0) {
                console.log(`Found ${fileData.attachments.length} attachments in ${normalizedName}`);
                for (const attach of fileData.attachments) {
                    const attachmentData = msgReader.getAttachment(attach);
                    if (attachmentData && attachmentData.content) {
                        const attachBuffer = Buffer.from(attachmentData.content);
                        const attachFilename = attachmentData.fileName || "attachment";
                        const attachPath = `${normalizedName} > ${attachFilename}`;
                        const nestedParts = await processFile(attachBuffer, attachFilename, manifest, attachPath);
                        parts.push(...nestedParts);
                    }
                }
            }
        } else if (filename.endsWith(".docx")) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            const text = `--- DOCUMENT: ${normalizedName} ---\n${result.value}`;
            parts.push({
                inlineData: {
                    data: Buffer.from(text).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls") || filename.endsWith(".csv")) {
            const workbook = XLSX.read(fileBuffer, { type: "buffer" });
            let text = `--- SPREADSHEET: ${normalizedName} ---\n`;
            workbook.SheetNames.forEach((sheetName) => {
                const sheet = workbook.Sheets[sheetName];
                const csvData = XLSX.utils.sheet_to_csv(sheet);
                text += `\nSheet: ${sheetName}\n${csvData}\n`;
            });
            parts.push({
                inlineData: {
                    data: Buffer.from(text).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        } else if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
            parts.push({
                inlineData: {
                    data: fileBuffer.toString("base64"),
                    mimeType: mimeType,
                },
            });
        } else {
            parts.push({
                inlineData: {
                    data: Buffer.from(`--- BINARY FILE: ${normalizedName} ---`).toString("base64"),
                    mimeType: "text/plain",
                },
            });
        }
    } catch (error) {
        console.error(`Error processing ${normalizedName}:`, error);
    }

    return parts;
}

export async function POST(request: NextRequest) {
    const blobsToDelete: string[] = [];

    try {
        const body = await request.json();
        const { blobs } = body;

        if (!blobs || !Array.isArray(blobs)) {
            return NextResponse.json({ error: "Invalid request: blobs array required" }, { status: 400 });
        }

        const geminiParts: { inlineData: { data: string; mimeType: string } }[] = [];
        const manifest: string[] = [];

        // Download and process files from blob URLs
        for (const blobInfo of blobs) {
            const { blobUrl, filename, section } = blobInfo;
            blobsToDelete.push(blobUrl);

            try {
                const response = await fetch(blobUrl);
                if (!response.ok) {
                    console.error(`Failed to download blob: ${blobUrl}`);
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();
                const fileBuffer = Buffer.from(arrayBuffer);

                // Add section header
                if (section === "files_prior") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: PRIOR YEAR FILES (Context Only) ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                } else if (section === "files_t776") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: PRIOR YEAR T776 (Template) ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                } else if (section === "files_current") {
                    geminiParts.push({
                        inlineData: {
                            data: Buffer.from("--- SECTION: CURRENT YEAR FILES ---").toString("base64"),
                            mimeType: "text/plain",
                        },
                    });
                }

                const parts = await processFile(fileBuffer, filename, manifest, "");
                geminiParts.push(...parts);
            } catch (error) {
                console.error(`Error processing blob ${filename}:`, error);
            }
        }

        // Enhanced Prompt (same as before)
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
      - **CLIENT IDENTITY**: Use the name found in the Prior Year T776. If the sender/recipient in Current Year emails does NOT match the Prior T776 name, flag it in the notes.
      
      **OUTPUT FORMAT (STRICT JSON)**:
      {
        "tax_year": number,
        "properties": [
          {
            "address": "string (from Prior T776)",
            "income": {
              "category_name": { "amount": number, "source_file": "string (filename or Email.msg > Attachment)" }
            },
            "income_prior": { "category_name": number },
            "expenses": {
              "category_name": { "amount": number, "source_file": "string" }
            },
            "expenses_prior": { "category_name": number },
            "source_files_read": ["string (all files you referenced for this property)"],
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

        // Clean up blobs
        for (const blobUrl of blobsToDelete) {
            try {
                await del(blobUrl);
                console.log(`Deleted blob: ${blobUrl}`);
            } catch (error) {
                console.error(`Failed to delete blob ${blobUrl}:`, error);
            }
        }

        return NextResponse.json({ data });

    } catch (error: any) {
        console.error("Analysis error:", error);

        // Attempt cleanup even on error
        for (const blobUrl of blobsToDelete) {
            try {
                await del(blobUrl);
            } catch (e) {
                console.error(`Cleanup failed for ${blobUrl}:`, e);
            }
        }

        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
