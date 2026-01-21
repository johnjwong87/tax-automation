const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config({ path: ".env" });

async function listModels() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        // There isn't a direct listModels on the client instance in some versions, 
        // but let's try a standard request or look at the error more closely.
        // actually the SDK has a model manager in some versions but usually we just try to use one.
        // Let's rely on a raw fetch to list models if the SDK doesn't expose it easily in node.

        // Using raw fetch to be sure
        const apiKey = process.env.GEMINI_API_KEY;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        if (data.models) {
            console.log("Available Models:");
            data.models.forEach(m => {
                if (m.supportedGenerationMethods.includes("generateContent")) {
                    console.log(`- ${m.name}`);
                }
            });
        } else {
            console.log("Error listing models:", JSON.stringify(data, null, 2));
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

listModels();
