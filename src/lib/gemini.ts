import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: { responseMimeType: "application/json" }
});

export async function analyzeRentalDocuments(prompt: string, fileParts: { inlineData: { data: string; mimeType: string } }[]) {
    const maxRetries = 6;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const result = await model.generateContent([prompt, ...fileParts]);
            return result.response.text();
        } catch (error: any) {
            const errMsg = error.message || error.toString();
            console.log(`Gemini API Error (Attempt ${attempt + 1}):`, errMsg);

            if (
                errMsg.includes("429") ||
                errMsg.includes("Too Many Requests") ||
                errMsg.includes("Resource exhausted") ||
                errMsg.includes("quota")
            ) {
                attempt++;
                if (attempt >= maxRetries) throw new Error(`Gemini API Failed after ${maxRetries} attempts. Last error: ${errMsg}`);

                let delay = 10000 * attempt; // Default: 10s, 20s, 30s, 40s...

                // Try to parse "retry in X s" or "retryDelay":"Xs"
                const matchWait = errMsg.match(/retry in (\d+(\.\d+)?)s/);
                const matchDelay = errMsg.match(/"retryDelay":"(\d+)s"/);

                if (matchWait) {
                    delay = Math.ceil(parseFloat(matchWait[1]) * 1000) + 2000;
                } else if (matchDelay) {
                    delay = parseInt(matchDelay[1]) * 1000 + 2000;
                }

                console.log(`Rate limit hit. Retrying in ${delay / 1000}s... (Attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error;
            }
        }
    }
    throw new Error("Max retries exceeded");

}

