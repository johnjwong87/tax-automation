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

        // NEW Senior CPA Reasoning Prompt
        const prompt = `
      # ROLE: Senior CPA & Tax Reviewer (T776 Specialized)
      Your value is Critical Analysis and Error Detection. Do not blindly accept client data; audit it for consistency, completeness, and tax compliance (Accrual Basis).

      # SOURCES OF TRUTH:
      1. LEGAL/HISTORICAL BASELINE (SECTION: PRIOR YEAR FILES): Lease agreements, mortgage contracts, property tax assessments. (Determines what SHOULD happen).
      2. PRIOR BENCHMARK (SECTION: PRIOR YEAR T776): What was reported last year. (Establishes trend/run-rate).
      3. CLIENT CLAIM (SECTION: CURRENT YEAR FILES): Raw data/spreadsheets/receipts provided this year. (What DID happen according to client).

      # CPA REASONING PROTOCOL:
      
      ## Step 1: Construct the "Expected Reality"
      Look at PRIOR YEAR FILES and PRIOR YEAR T776.
      - REVENUE: Based on leases, what SHOULD annual rent be? (Rate x 12).
      - EXPENSES: What fixed costs from last year (Property Tax, Insurance, Mortgage Interest) must exist this year?
      - TENANCY: Who is the tenant? When does the lease end?

      ## Step 2: Audit the "Reported Reality"
      Review CURRENT YEAR FILES. Extract totals and details.

      ## Step 3: Gap Analysis (Critical Thinking)
      Compare Expected vs. Reported. Identify LOGICAL DISCONNECTS:
      - REVENUE CONTINUITY: If Expected > Reported, why? (Vacancy? Arrears? Forgotten Deposit/LMR?).
      - EXPENSE CONTINUITY: Did a recurring expense from PY (Insurance/Property Tax) disappear? Assume it was missed.
      - EXPENSE SPIKES: Did Maintenance jump >100%? Is it a Capital Improvement (Class 1) disguised as an expense?
      - ACCRUAL CHECK: Does cash flow match contract dates? Does missing rent align with lease dates?

      # OUTPUT INSTRUCTIONS:

      1. T776 DATA:
      - Produce figures for Income and Expenses.
      - **AUTO-CORRECTION**: If you find evidence of Accrual items (like LMR application) the client missed, adjust figures to be tax-compliant. 
      - **FLAG**: Label any such items clearly as "AI Adjustment: [Reasoning]".

      2. SMART CLIENT EMAIL:
      - Draft clarifications. Never ask a question you can answer yourself. Connect the dots.
      - **FORMATTING RULE:** Use a numbered list (1., 2., 3.) with double spacing between items.
      - EXAMPLE GOOD:
        "1. Last year, we claimed $1,200 for insurance. Your current spreadsheet lists $0. Did you pay the insurance policy this year, or was it perhaps missed in the upload?

        2. The lease on file shows rent of $4,000/mo. Your totals show $40,000. Were there 2 months of vacancy?"

      # OUTPUT FORMAT (STRICT JSON):
      {
        "tax_year": number,
        "properties": [
          {
            "address": "string",
            "income": {
              "category_name": { "amount": number, "source_file": "string" }
            },
            "income_prior": { "category_name": number },
            "expenses": {
              "category_name": { "amount": number, "source_file": "string" }
            },
            "expenses_prior": { "category_name": number },
            "source_files_read": ["string"],
            "notes": "string (Include LOGICAL DISCONNECTS found and AI ADJUSTMENTS here)"
          }
        ],
        "email_draft": "string",
        "all_files_detected": ["string"]
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
                console.log(`Deleted blob: ${blobUrl} `);
            } catch (error) {
                console.error(`Failed to delete blob ${blobUrl}: `, error);
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
                console.error(`Cleanup failed for ${blobUrl}: `, e);
            }
        }

        return NextResponse.json(
            { error: error.message || "Internal Server Error" },
            { status: 500 }
        );
    }
}
