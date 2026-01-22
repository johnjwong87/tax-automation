import * as XLSX from "xlsx";
import JSZip from "jszip";
import MsgReader from "@kenjiuno/msgreader";

interface SourceMapping {
    amount: number;
    source_file: string;
}

interface PropertyData {
    address: string;
    income: Record<string, SourceMapping>;
    income_prior: Record<string, number>;
    expenses: Record<string, SourceMapping>;
    expenses_prior: Record<string, number>;
    source_files_read: string[];
    notes: string;
}

interface AnalysisResult {
    properties: PropertyData[];
    tax_year?: number;
    all_files_detected: string[];
}

/**
 * Generates only the Excel summary workbook as a Blob.
 */
export async function generateExcelSummary(result: AnalysisResult): Promise<Blob> {
    const workbook = XLSX.utils.book_new();
    const currentYearLabel = result.tax_year ? `Current (${result.tax_year})` : "Current Year";
    const priorYearLabel = result.tax_year ? `Prior (${result.tax_year - 1})` : "Prior Year";

    result.properties.forEach((prop, idx) => {
        const sheetName = (prop.address || `Prop ${idx + 1}`).substring(0, 31);
        const rows: any[][] = [];
        rows.push(["PROPERTY SUMMARY", prop.address || "Unknown"]);
        rows.push([""]);

        const incomeCats = Array.from(new Set([
            ...Object.keys(prop.income || {}),
            ...Object.keys(prop.income_prior || {})
        ])).sort();

        rows.push(["INCOME", priorYearLabel, currentYearLabel, "Variance", "Source File (Link)"]);

        let totalPrior = 0;
        let totalCurrent = 0;

        incomeCats.forEach(cat => {
            const prior = prop.income_prior?.[cat] || 0;
            const currentObj = prop.income?.[cat];
            const current = typeof currentObj === 'object' ? currentObj.amount : (currentObj || 0);
            const source = typeof currentObj === 'object' ? currentObj.source_file : "";
            const row = [cat, prior, current, current - prior, source];
            rows.push(row);
            totalPrior += prior;
            totalCurrent += current;
        });
        rows.push(["TOTAL INCOME", totalPrior, totalCurrent, totalCurrent - totalPrior]);
        rows.push([""]);

        const expenseCats = Array.from(new Set([
            ...Object.keys(prop.expenses || {}),
            ...Object.keys(prop.expenses_prior || {})
        ])).sort();

        rows.push(["EXPENSES", priorYearLabel, currentYearLabel, "Variance", "Source File (Link)"]);
        let totalExpPrior = 0;
        let totalExpCurrent = 0;

        expenseCats.forEach(cat => {
            const prior = prop.expenses_prior?.[cat] || 0;
            const currentObj = prop.expenses?.[cat];
            const current = typeof currentObj === 'object' ? currentObj.amount : (currentObj || 0);
            const source = typeof currentObj === 'object' ? currentObj.source_file : "";
            const row = [cat, prior, current, current - prior, source];
            rows.push(row);
            totalExpPrior += prior;
            totalExpCurrent += current;
        });
        rows.push(["TOTAL EXPENSES", totalExpPrior, totalExpCurrent, totalExpCurrent - totalExpPrior]);
        rows.push([""]);
        rows.push(["NET RENTAL INCOME", totalPrior - totalExpPrior, totalCurrent - totalExpCurrent, (totalCurrent - totalExpCurrent) - (totalPrior - totalExpPrior)]);

        if (prop.notes) {
            rows.push([""]);
            rows.push(["NOTES / MISSING INFO"]);
            rows.push([prop.notes]);
        }
        rows.push([""]);
        rows.push(["FILES PROCESSED FOR THIS PROPERTY"]);
        (prop.source_files_read || []).forEach(f => rows.push([f]));

        const worksheet = XLSX.utils.aoa_to_sheet(rows);
        const fmt = '#,##0.00';
        const getRef = (c: number, r: number) => XLSX.utils.encode_cell({ c, r });

        let incomeStart = -1, incomeEnd = -1, totalIncomeRow = -1;
        let expenseStart = -1, expenseEnd = -1, totalExpenseRow = -1;
        let netIncomeRow = -1;

        rows.forEach((r, rIdx) => {
            const firstCell = r[0];
            if (firstCell === "INCOME") {
                incomeStart = rIdx + 1;
            } else if (firstCell === "TOTAL INCOME") {
                incomeEnd = rIdx - 1;
                totalIncomeRow = rIdx;
            } else if (firstCell === "EXPENSES") {
                expenseStart = rIdx + 1;
            } else if (firstCell === "TOTAL EXPENSES") {
                expenseEnd = rIdx - 1;
                totalExpenseRow = rIdx;
            } else if (firstCell === "NET RENTAL INCOME") {
                netIncomeRow = rIdx;
            }

            [1, 2, 3].forEach(cIdx => {
                const cell = worksheet[getRef(cIdx, rIdx)];
                if (cell && typeof cell.v === 'number') {
                    cell.z = fmt;
                }
            });

            if (rIdx > 0 && r[0] && !["INCOME", "EXPENSES", "TOTAL INCOME", "TOTAL EXPENSES", "NET RENTAL INCOME", ""].includes(String(r[0])) && !String(r[0]).startsWith("NOTES") && !String(r[0]).startsWith("FILES")) {
                const cellD = worksheet[getRef(3, rIdx)];
                if (cellD) {
                    cellD.f = `${getRef(2, rIdx)}-${getRef(1, rIdx)}`;
                }
            }
        });

        if (incomeStart !== -1 && incomeEnd >= incomeStart) {
            worksheet[getRef(1, totalIncomeRow)] = { f: `SUM(${getRef(1, incomeStart)}:${getRef(1, incomeEnd)})`, z: fmt };
            worksheet[getRef(2, totalIncomeRow)] = { f: `SUM(${getRef(2, incomeStart)}:${getRef(2, incomeEnd)})`, z: fmt };
            worksheet[getRef(3, totalIncomeRow)] = { f: `${getRef(2, totalIncomeRow)}-${getRef(1, totalIncomeRow)}`, z: fmt };
        }

        if (expenseStart !== -1 && expenseEnd >= expenseStart) {
            worksheet[getRef(1, totalExpenseRow)] = { f: `SUM(${getRef(1, expenseStart)}:${getRef(1, expenseEnd)})`, z: fmt };
            worksheet[getRef(2, totalExpenseRow)] = { f: `SUM(${getRef(2, expenseStart)}:${getRef(2, expenseEnd)})`, z: fmt };
            worksheet[getRef(3, totalExpenseRow)] = { f: `${getRef(2, totalExpenseRow)}-${getRef(1, totalExpenseRow)}`, z: fmt };
        }

        if (netIncomeRow !== -1 && totalIncomeRow !== -1 && totalExpenseRow !== -1) {
            worksheet[getRef(1, netIncomeRow)] = { f: `${getRef(1, totalIncomeRow)}-${getRef(1, totalExpenseRow)}`, z: fmt };
            worksheet[getRef(2, netIncomeRow)] = { f: `${getRef(2, totalIncomeRow)}-${getRef(2, totalExpenseRow)}`, z: fmt };
            worksheet[getRef(3, netIncomeRow)] = { f: `${getRef(2, netIncomeRow)}-${getRef(1, netIncomeRow)}`, z: fmt };
        }

        rows.forEach((r, rIdx) => {
            let sourceFile = r[4];
            if (sourceFile && rIdx > 0 && (r[0] !== "INCOME" && r[0] !== "EXPENSES" && !r[0].startsWith("TOTAL"))) {
                const sanitizedPath = sourceFile.replace(/ > /g, "_attachments/").replace(/\\/g, "/");
                const cellRef = XLSX.utils.encode_cell({ c: 4, r: rIdx });
                worksheet[cellRef].l = {
                    Target: `Source_Documents/${sanitizedPath}`,
                    Tooltip: `Click to open source file`
                };
            }
        });

        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    });

    const manifestRows = [["FULL AUDIT TRAIL - ALL FILES PROCESSED"], [""]];
    result.all_files_detected?.forEach(f => manifestRows.push([f]));
    const citedFiles = new Set<string>();
    result.properties.forEach(prop => {
        Object.values(prop.income || {}).forEach(m => { if (m.source_file) citedFiles.add(m.source_file); });
        Object.values(prop.expenses || {}).forEach(m => { if (m.source_file) citedFiles.add(m.source_file); });
    });
    const unusedFiles = (result.all_files_detected || []).filter(f => {
        const isReference = f.startsWith("PRIOR") || f.startsWith("TEMPLATE");
        return !isReference && !citedFiles.has(f);
    });
    if (unusedFiles.length > 0) {
        manifestRows.push([""]);
        manifestRows.push(["UNUSED FILES (FOR REVIEW)"]);
        unusedFiles.forEach(f => manifestRows.push([f]));
    }
    const manifestSheet = XLSX.utils.aoa_to_sheet(manifestRows);
    XLSX.utils.book_append_sheet(workbook, manifestSheet, "Audit Trail");

    const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    return new Blob([excelBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/**
 * Generates the full ZIP package containing Excel summary and Source Documents.
 */
export async function generateAuditPackage(result: AnalysisResult, originalFiles: File[]): Promise<Blob> {
    const zip = new JSZip();
    const sourceFolder = zip.folder("Source_Documents");
    if (!sourceFolder) throw new Error("Could not create ZIP folder");

    console.log("Generating Audit Package ZIP...");

    // 1. Add Original Files to the ZIP
    for (const file of originalFiles) {
        const buffer = await file.arrayBuffer();
        const zipPath = file.webkitRelativePath || file.name;
        sourceFolder.file(zipPath, buffer);

        if (file.name.toLowerCase().endsWith(".msg")) {
            try {
                const reader = new MsgReader(buffer);
                const data = reader.getFileData();
                if (data.attachments) {
                    const msgFolderName = `${file.webkitRelativePath || file.name}_attachments`;
                    for (const attach of data.attachments) {
                        const attachmentData = reader.getAttachment(attach);
                        if (attachmentData) {
                            sourceFolder.file(`${msgFolderName}/${attachmentData.fileName}`, attachmentData.content);
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed to extra attachments from ${file.name}`, err);
            }
        }
    }

    // 2. Add the Excel Summary to the ZIP
    const excelBlob = await generateExcelSummary(result);
    const excelArrayBuffer = await excelBlob.arrayBuffer();
    zip.file("T776_Tax_Summary.xlsx", new Uint8Array(excelArrayBuffer));

    // 3. Generate the ZIP Blob
    const zipBlob = await zip.generateAsync({
        type: "blob",
        mimeType: "application/zip",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
    });
    return zipBlob;
}
