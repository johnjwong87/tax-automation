import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { properties, tax_year } = body;

        if (!properties || !Array.isArray(properties)) {
            return NextResponse.json(
                { error: "Invalid data format" },
                { status: 400 }
            );
        }

        const workbook = XLSX.utils.book_new();

        // Calculate labels
        const currentYearLabel = tax_year ? `Current Year (${tax_year}) ($)` : "Current Year ($)";
        const priorYearLabel = tax_year ? `Prior Year (${tax_year - 1}) ($)` : "Prior Year ($)";

        properties.forEach((property: any, index: number) => {
            const sheetName = (property.address || `Property ${index + 1}`).substring(0, 31);

            const rows: any[][] = [];
            rows.push(["Property Address", property.address || "Unknown"]);
            rows.push([""]);

            // Helper to merge categories from both years
            const mergeCategories = (current: any = {}, prior: any = {}) => {
                const cats = new Set([...Object.keys(current), ...Object.keys(prior)]);
                return Array.from(cats).sort();
            };

            // INCOME SECTION
            rows.push(["INCOME", priorYearLabel, currentYearLabel, "Variance ($)"]);
            const incomeCats = mergeCategories(property.income, property.income_prior);

            let totalIncomePrior = 0;
            let totalIncomeCurrent = 0;

            incomeCats.forEach(cat => {
                const priorVal = property.income_prior?.[cat] || 0;
                const currentVal = property.income?.[cat] || 0;
                const variance = currentVal - priorVal;

                totalIncomePrior += priorVal;
                totalIncomeCurrent += currentVal;

                rows.push([cat, priorVal, currentVal, variance]);
            });
            rows.push(["TOTAL INCOME", totalIncomePrior, totalIncomeCurrent, totalIncomeCurrent - totalIncomePrior]);
            rows.push([""]);

            // EXPENSES SECTION
            rows.push(["EXPENSES", priorYearLabel, currentYearLabel, "Variance ($)"]);
            const expenseCats = mergeCategories(property.expenses, property.expenses_prior);

            let totalExpensePrior = 0;
            let totalExpenseCurrent = 0;

            expenseCats.forEach(cat => {
                const priorVal = property.expenses_prior?.[cat] || 0;
                const currentVal = property.expenses?.[cat] || 0;
                const variance = currentVal - priorVal;

                totalExpensePrior += priorVal;
                totalExpenseCurrent += currentVal;

                rows.push([cat, priorVal, currentVal, variance]);
            });
            rows.push(["TOTAL EXPENSES", totalExpensePrior, totalExpenseCurrent, totalExpenseCurrent - totalExpensePrior]);

            rows.push([""]);
            rows.push(["NET INCOME", totalIncomePrior - totalExpensePrior, totalIncomeCurrent - totalExpenseCurrent, (totalIncomeCurrent - totalExpenseCurrent) - (totalIncomePrior - totalExpensePrior)]);


            if (property.notes) {
                rows.push([""]);
                rows.push(["NOTES / MISSING INFO"]);
                rows.push([property.notes]);
            }

            if (property.source_files) {
                rows.push([""]);
                rows.push(["SOURCE FILES"]);
                rows.push([property.source_files.join(", ")]);
            }

            const worksheet = XLSX.utils.aoa_to_sheet(rows);

            // Set column widths
            worksheet["!cols"] = [
                { wch: 30 }, // Category
                { wch: 15 }, // Prior
                { wch: 15 }, // Current
                { wch: 15 }, // Variance
            ];

            XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        });

        const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        return new NextResponse(buffer, {
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": 'attachment; filename="rental_tax_summary_comparative.xlsx"',
            },
        });
    } catch (error) {
        console.error("Export error:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}
