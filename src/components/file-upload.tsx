"use client";

import { useState, useCallback } from "react";
import { Upload, X, File as FileIcon } from "lucide-react";
import { clsx } from "clsx";

interface FileUploadProps {
    onFilesSelected: (files: File[]) => void;
    isLoading?: boolean;
    title?: string;
    description?: string;
}

export function FileUpload({ onFilesSelected, isLoading, title, description }: FileUploadProps) {
    const [dragActive, setDragActive] = useState(false);
    const [files, setFiles] = useState<File[]>([]);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);

        const items = e.dataTransfer.items;
        if (!items) return;

        const newFiles: File[] = [];

        async function traverse(entry: any, path: string = "") {
            if (entry.isFile) {
                const file = await new Promise<File>((resolve) => entry.file(resolve));
                // We create a new "File" like object but preserving the path for our later FormData logic
                Object.defineProperty(file, 'webkitRelativePath', {
                    value: path ? `${path}/${file.name}` : file.name,
                    writable: false
                });
                newFiles.push(file);
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const entries = await new Promise<any[]>((resolve) => {
                    const allEntries: any[] = [];
                    const readBatch = () => {
                        reader.readEntries((batch: any[]) => {
                            if (batch.length > 0) {
                                allEntries.push(...batch);
                                readBatch();
                            } else {
                                resolve(allEntries);
                            }
                        });
                    };
                    readBatch();
                });
                for (const child of entries) {
                    await traverse(child, path ? `${path}/${entry.name}` : entry.name);
                }
            }
        }

        const traversePromises = [];
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) {
                traversePromises.push(traverse(entry));
            }
        }

        await Promise.all(traversePromises);

        if (newFiles.length > 0) {
            setFiles((prev) => [...prev, ...newFiles]);
            onFilesSelected([...files, ...newFiles]);
        }
    }, [files, onFilesSelected]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (e.target.files && e.target.files.length > 0) {
            const newFiles = Array.from(e.target.files);
            setFiles((prev) => [...prev, ...newFiles]);
            onFilesSelected([...files, ...newFiles]);
        }
    };

    const removeFile = (index: number) => {
        const newFiles = [...files];
        newFiles.splice(index, 1);
        setFiles(newFiles);
        onFilesSelected(newFiles);
    };

    return (
        <div className="w-full max-w-2xl mx-auto space-y-4">
            <div
                className={clsx(
                    "relative h-64 border-2 border-dashed rounded-lg flex flex-col items-center justify-center transition-colors",
                    dragActive ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50",
                    isLoading && "opacity-50 pointer-events-none"
                )}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
            >
                <div className="text-center space-y-2">
                    {title && <h3 className="text-lg font-semibold text-gray-700">{title}</h3>}
                    {description && <p className="text-sm text-gray-500 max-w-sm mx-auto">{description}</p>}
                    <Upload className="w-12 h-12 text-gray-400 mx-auto mt-4" />
                    <p className="text-sm text-gray-600">
                        Drag and drop your files here, or{" "}
                        <span className="space-x-1">
                            <label className="text-blue-500 hover:text-blue-600 cursor-pointer font-medium">
                                browse files
                                <input
                                    type="file"
                                    className="hidden"
                                    multiple
                                    onChange={handleChange}
                                    disabled={isLoading}
                                />
                            </label>
                            <span className="text-gray-400">or</span>
                            <label className="text-blue-500 hover:text-blue-600 cursor-pointer font-medium">
                                browse folder
                                <input
                                    type="file"
                                    className="hidden"
                                    // @ts-ignore - webkitdirectory is non-standard but widely supported
                                    webkitdirectory=""
                                    directory=""
                                    onChange={handleChange}
                                    disabled={isLoading}
                                />
                            </label>
                        </span>
                    </p>
                    <p className="text-xs text-gray-500">
                        Supports PDF, Images, Word, Excel, MSG
                    </p>
                </div>
            </div>

            {files.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-sm font-medium text-gray-700">Selected Files</h3>
                    <div className="grid gap-2 max-h-60 overflow-y-auto">
                        {files.map((file, idx) => (
                            <div
                                key={`${file.name}-${idx}`}
                                className="flex items-center justify-between p-3 bg-white border border-gray-200 rounded-lg shadow-sm"
                            >
                                <div className="flex items-center space-x-3">
                                    <FileIcon className="w-5 h-5 text-blue-500" />
                                    <div>
                                        <p className="text-sm font-medium text-gray-700 truncate max-w-[300px]">
                                            {file.name}
                                        </p>
                                        <p className="text-xs text-gray-500">
                                            {(file.size / 1024).toFixed(1)} KB
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => removeFile(idx)}
                                    className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                                    disabled={isLoading}
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
