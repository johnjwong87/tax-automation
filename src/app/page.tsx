"use client";

import { useState } from "react";
import { FileUpload } from "@/components/file-upload";
import { Loader2, FileSpreadsheet, Package, Upload } from "lucide-react";
import { generateAuditPackage } from "@/utils/export-client";
import { upload } from "@vercel/blob/client";

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
    email_draft?: string;
    tax_year?: number;
    all_files_detected: string[];
}

export default function Home() {
    const [filesCurrent, setFilesCurrent] = useState<File[]>([]);
    const [filesPrior, setFilesPrior] = useState<File[]>([]);
    const [filesT776, setFilesT776] = useState<File[]>([]);

    const [isUploading, setIsUploading] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [uploadProgress, setUploadProgress] = useState("");
    const [result, setResult] = useState<AnalysisResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleAnalyze = async () => {
        if (filesCurrent.length === 0) return;

        setIsUploading(true);
        setIsAnalyzing(false);
        setError(null);
        setResult(null);
        setUploadProgress("Uploading files to secure storage...");

        try {
            // Step 1: Direct Upload files to Blob Storage (Bypasses 4.5MB limit)
            const blobPromises = [
                ...filesPrior.map(f => upload(f.name, f, { access: 'public', handleUploadUrl: '/api/upload' }).then((b: any) => ({ blobUrl: b.url, filename: f.name, section: 'files_prior' }))),
                ...filesT776.map(f => upload(f.name, f, { access: 'public', handleUploadUrl: '/api/upload' }).then((b: any) => ({ blobUrl: b.url, filename: f.name, section: 'files_t776' }))),
                ...filesCurrent.map(f => upload(f.name, f, { access: 'public', handleUploadUrl: '/api/upload' }).then((b: any) => ({ blobUrl: b.url, filename: f.name, section: 'files_current' }))),
            ];

            const blobs = await Promise.all(blobPromises);

            setIsUploading(false);
            setIsAnalyzing(true);
            setUploadProgress("Processing with AI...");

            // Step 2: Send blob URLs to analysis API
            const analyzeResponse = await fetch("/api/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ blobs }),
            });

            if (!analyzeResponse.ok) {
                const text = await analyzeResponse.text();
                let errMsg = "Analysis failed";
                try {
                    const errData = JSON.parse(text);
                    errMsg = errData.error || errMsg;
                } catch {
                    if (text.length < 200) errMsg = text;
                }
                throw new Error(errMsg);
            }

            const text = await analyzeResponse.text();
            try {
                const data = JSON.parse(text);
                setResult(data.data);
                setUploadProgress("");
            } catch (e) {
                console.error("Malformed JSON:", text);
                throw new Error("The AI returned an invalid response format. Please try again.");
            }
        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : "An error occurred");
            setUploadProgress("");
        } finally {
            setIsUploading(false);
            setIsAnalyzing(false);
        }
    };

    const handleDownloadPackage = async () => {
        if (!result) return;
        setIsExporting(true);
        try {
            const blob = await generateAuditPackage(result, [...filesCurrent, ...filesPrior, ...filesT776]);
            const filename = `Rental_Tax_Package_${result.tax_year || 'Audit'}.zip`;

            // Create a temporary hidden link
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.style.display = 'none';
            a.href = url;
            a.download = filename;

            document.body.appendChild(a);
            a.click();

            // Keep the URL alive for a bit to ensure the browser captures it
            setTimeout(() => {
                if (document.body.contains(a)) document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }, 30000);
        } catch (e) {
            console.error("ZIP Generation Error:", e);
            alert("Failed to generate Audit Package ZIP. Check console for details.");
        } finally {
            setIsExporting(false);
        }
    };

    const isProcessing = isUploading || isAnalyzing;

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
            <title>TaxFlow Rental Automation</title>
            <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="bg-blue-600 p-1.5 rounded-lg">
                            <FileSpreadsheet className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-xl font-extrabold tracking-tight text-gray-900">
                            TaxFlow <span className="text-blue-600 underline decoration-blue-200 underline-offset-4">Rental</span>
                        </span>
                        <span className="ml-3 px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-black rounded-md border border-blue-200 uppercase tracking-widest">
                            v2.0 Senior CPA
                        </span>
                    </div>
                </div>
            </header>

            <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
                <div className="text-center space-y-3">
                    <h1 className="text-4xl font-black text-gray-900 tracking-tight">
                        Rental Tax Automation
                    </h1>
                    <p className="text-lg text-gray-600 max-w-2xl mx-auto font-medium">
                        AI-powered T776 categorization with full source file auditing. <span className="text-green-600 font-bold">No file size limits!</span>
                    </p>
                </div>

                <div className="bg-white p-8 rounded-2xl shadow-xl shadow-blue-900/5 border border-gray-100 space-y-10">
                    <div className="grid md:grid-cols-2 gap-8">
                        <FileUpload
                            title="1. Prior Year Files"
                            description="Historical receipts for context."
                            onFilesSelected={setFilesPrior}
                            isLoading={isProcessing}
                        />
                        <FileUpload
                            title="2. Prior Year T776"
                            description="Last year's final return for template mapping."
                            onFilesSelected={setFilesT776}
                            isLoading={isProcessing}
                        />
                    </div>

                    <div className="pt-8 border-t border-gray-100">
                        <FileUpload
                            title="3. Current Year Documents"
                            description="Receipts, bank statements, and invoices for the new tax year."
                            onFilesSelected={setFilesCurrent}
                            isLoading={isProcessing}
                        />
                    </div>

                    <div className="flex justify-center pt-2">
                        <button
                            onClick={handleAnalyze}
                            disabled={filesCurrent.length === 0 || isProcessing}
                            className="group relative inline-flex items-center px-10 py-4 bg-blue-600 text-white font-bold text-lg rounded-full shadow-lg hover:bg-blue-700 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed"
                        >
                            {isUploading ? (
                                <>
                                    <Upload className="animate-bounce -ml-1 mr-3 h-6 w-6" />
                                    Uploading Files...
                                </>
                            ) : isAnalyzing ? (
                                <>
                                    <Loader2 className="animate-spin -ml-1 mr-3 h-6 w-6" />
                                    Building Tax Model...
                                </>
                            ) : (
                                "Execute Analysis"
                            )}
                            <div className="absolute -inset-1 rounded-full bg-blue-400 opacity-20 group-hover:opacity-40 blur-lg transition-opacity animate-pulse pointer-events-none"></div>
                        </button>
                    </div>

                    {uploadProgress && (
                        <div className="text-center text-sm text-blue-600 font-semibold animate-pulse">
                            {uploadProgress}
                        </div>
                    )}
                </div>

                {error && (
                    <div className="bg-red-50 border-l-4 border-red-500 p-5 rounded-r-xl animate-in shake duration-300">
                        <div className="flex">
                            <div className="ml-3">
                                <p className="text-sm font-bold text-red-800">Processing Error</p>
                                <p className="text-sm text-red-700 mt-1">{error}</p>
                            </div>
                        </div>
                    </div>
                )}

                {result && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
                        <div className="flex items-center justify-between border-b border-gray-200 pb-5">
                            <div>
                                <h2 className="text-3xl font-black text-gray-900 tracking-tight">Tax Review Complete</h2>
                                <p className="text-gray-500 mt-1 font-medium">Triangulated reporting from Historical, Benchmark, and Current sources.</p>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                                <button
                                    onClick={handleDownloadPackage}
                                    disabled={isExporting}
                                    className="inline-flex items-center px-6 py-3 bg-green-600 text-white font-bold rounded-xl shadow-lg hover:bg-green-700 hover:shadow-green-900/20 active:translate-y-0.5 transition-all disabled:opacity-50"
                                >
                                    {isExporting ? (
                                        <>
                                            <Loader2 className="w-5 h-5 mr-3 animate-spin" />
                                            Generating ZIP...
                                        </>
                                    ) : (
                                        <>
                                            <Package className="w-5 h-5 mr-3" />
                                            Download Audit Package (.ZIP)
                                        </>
                                    )}
                                </button>
                                <p className="text-[10px] text-gray-400 font-medium italic">
                                    Includes Excel Summary + All Source Files
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-8">
                            {result.properties?.map((property, idx) => (
                                <div key={idx} className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden group transition-all hover:border-blue-200 hover:shadow-blue-900/5">
                                    <div className="bg-gray-50/50 px-8 py-5 border-b border-gray-200 flex justify-between items-center group-hover:bg-blue-50/30 transition-colors">
                                        <h3 className="text-xl font-extrabold text-gray-900">{property.address || "New Property Location"}</h3>
                                        <div className="flex gap-2">
                                            <span className="px-3 py-1 bg-white border border-gray-200 rounded-full text-xs font-bold text-gray-600 uppercase tracking-widest">
                                                {result.tax_year} RETURN
                                            </span>
                                        </div>
                                    </div>

                                    <div className="p-8 grid lg:grid-cols-2 gap-10">
                                        <div>
                                            <h4 className="flex items-center text-xs font-black text-blue-600 uppercase tracking-widest mb-6 px-1">
                                                <div className="w-2 h-2 rounded-full bg-blue-600 mr-2"></div>
                                                Income Stream
                                            </h4>
                                            <div className="space-y-2">
                                                {property.income && Object.entries(property.income).map(([cat, detail]) => (
                                                    <div key={cat} className="flex flex-col p-3 rounded-lg hover:bg-gray-50 transition-colors">
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-sm font-semibold text-gray-700 capitalize">{cat}</span>
                                                            <span className="text-sm font-black text-gray-900 font-mono">${detail.amount?.toLocaleString()}</span>
                                                        </div>
                                                        {detail.source_file && (
                                                            <span className="text-[10px] text-gray-400 mt-1 italic">Source: {detail.source_file}</span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div>
                                            <h4 className="flex items-center text-xs font-black text-orange-600 uppercase tracking-widest mb-6 px-1">
                                                <div className="w-2 h-2 rounded-full bg-orange-600 mr-2"></div>
                                                Operating Expenses
                                            </h4>
                                            <div className="space-y-2">
                                                {property.expenses && Object.entries(property.expenses).map(([cat, detail]) => (
                                                    <div key={cat} className="flex flex-col p-3 rounded-lg hover:bg-gray-50 transition-colors">
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-sm font-semibold text-gray-700 capitalize">{cat}</span>
                                                            <span className="text-sm font-black text-gray-900 font-mono">${detail.amount?.toLocaleString()}</span>
                                                        </div>
                                                        {detail.source_file && (
                                                            <span className="text-[10px] text-gray-400 mt-1 italic">Source: {detail.source_file}</span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {property.notes && (
                                        <div className="mx-8 mb-8 p-4 bg-amber-50 rounded-xl border border-amber-100">
                                            <h4 className="text-xs font-black text-amber-800 uppercase tracking-widest mb-1">Tax Adjustments / Auditor Notes</h4>
                                            <p className="text-sm text-amber-900 leading-relaxed">{property.notes}</p>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        {result.email_draft && (
                            <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden mt-10">
                                <div className="bg-indigo-600 px-8 py-5">
                                    <h3 className="text-lg font-bold text-white uppercase tracking-wider flex items-center">
                                        <Loader2 className="w-5 h-5 mr-3 opacity-50" />
                                        Generated Client Inquiry Draft
                                    </h3>
                                </div>
                                <div className="p-8">
                                    <textarea
                                        className="w-full h-80 p-6 bg-gray-50 border border-gray-200 rounded-2xl font-mono text-sm leading-relaxed focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
                                        readOnly
                                        value={result.email_draft}
                                    />
                                    <div className="mt-4 flex justify-between items-center">
                                        <p className="text-xs text-gray-500 uppercase font-black tracking-widest">Client Communication Block</p>
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(result.email_draft || "");
                                                alert("Copied to clipboard!");
                                            }}
                                            className="text-indigo-600 font-bold text-xs hover:underline"
                                        >
                                            COPY TO CLIPBOARD
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </main>

            <footer className="py-10 border-t border-gray-200 bg-white">
                <div className="max-w-7xl mx-auto px-4 text-center">
                    <p className="text-xs text-gray-400 font-bold uppercase tracking-[0.2em]">
                        Verified Audit Trail &bull; Gemini 2.0 Flash &bull; Unlimited File Uploads via Blob Storage
                    </p>
                </div>
            </footer>
        </div>
    );
}
