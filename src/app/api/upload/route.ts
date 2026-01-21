import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const uploadedBlobs: { blobUrl: string; filename: string; section: string }[] = [];

        // Process each file and upload to Blob Storage
        for (const [key, value] of formData.entries()) {
            if (value instanceof File) {
                const file = value as File;
                const section = key; // 'files_prior', 'files_t776', or 'files_current'

                // Upload to Vercel Blob with a unique path
                const blob = await put(file.name, file, {
                    access: 'public', // Temporary public access for processing
                    addRandomSuffix: true, // Prevents filename collisions
                });

                uploadedBlobs.push({
                    blobUrl: blob.url,
                    filename: file.name,
                    section: section,
                });
            }
        }

        return NextResponse.json({ blobs: uploadedBlobs });
    } catch (error: any) {
        console.error("Upload error:", error);
        return NextResponse.json(
            { error: error.message || "Upload failed" },
            { status: 500 }
        );
    }
}
