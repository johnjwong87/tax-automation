import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
    const body = (await request.json()) as HandleUploadBody;

    try {
        const jsonResponse = await handleUpload({
            body,
            request,
            onBeforeGenerateToken: async () => {
                return {
                    allowedContentTypes: [
                        'application/pdf',
                        'image/jpeg',
                        'image/png',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'application/vnd.ms-outlook',
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        'text/csv',
                        'application/octet-stream'
                    ],
                    tokenPayload: JSON.stringify({
                        // Any specific metadata you want to pass
                    }),
                };
            },
            onUploadCompleted: async ({ blob, tokenPayload }) => {
                // This is called after the file is uploaded to Vercel
                console.log('blob upload completed', blob, tokenPayload);
            },
        });

        return NextResponse.json(jsonResponse);
    } catch (error) {
        return NextResponse.json(
            { error: (error as Error).message },
            { status: 400 },
        );
    }
}
