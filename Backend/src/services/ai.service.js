const { GoogleGenAI, Type } = require("@google/genai");
const { z } = require("zod");
const puppeteer = require("puppeteer");

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_GENAI_API_KEY
});

// ---------------------------------------------
// Zod schemas
// ---------------------------------------------

const questionSchema = z.object({
    question: z.string(),
    intention: z.string(),
    answer: z.string()
});

const skillGapSchema = z.object({
    skill: z.string(),
    severity: z.enum(["low", "medium", "high"])
});

const preparationPlanSchema = z.object({
    day: z.number().int().min(1),
    focus: z.string(),
    tasks: z.array(z.string())
});

// Only fields that Gemini must generate.
const aiInterviewReportSchema = z.object({
    matchScore: z.number().min(0).max(100),
    technicalQuestions: z.array(questionSchema),
    behavioralQuestions: z.array(questionSchema),
    skillGaps: z.array(skillGapSchema),
    preparationPlan: z.array(preparationPlanSchema),
    title: z.string()
});

// Complete report expected by MongoDB/API.
const interviewReportSchema = z.object({
    jobDescription: z.string(),
    resume: z.string(),
    selfDescription: z.string(),

    matchScore: z.number().min(0).max(100),
    technicalQuestions: z.array(questionSchema),
    behavioralQuestions: z.array(questionSchema),
    skillGaps: z.array(skillGapSchema),
    preparationPlan: z.array(preparationPlanSchema),
    title: z.string()
});

const resumePdfSchema = z.object({
    html: z.string()
});

// ---------------------------------------------
// Gemini structured-output schema
// ---------------------------------------------

const geminiInterviewSchema = {
    type: Type.OBJECT,
    properties: {
        matchScore: {
            type: Type.NUMBER,
            description: "Candidate match score from 0 to 100."
        },
        technicalQuestions: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING },
                    intention: { type: Type.STRING },
                    answer: { type: Type.STRING }
                },
                required: ["question", "intention", "answer"]
            }
        },
        behavioralQuestions: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING },
                    intention: { type: Type.STRING },
                    answer: { type: Type.STRING }
                },
                required: ["question", "intention", "answer"]
            }
        },
        skillGaps: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    skill: { type: Type.STRING },
                    severity: {
                        type: Type.STRING,
                        enum: ["low", "medium", "high"]
                    }
                },
                required: ["skill", "severity"]
            }
        },
        preparationPlan: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    day: { type: Type.INTEGER },
                    focus: { type: Type.STRING },
                    tasks: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING }
                    }
                },
                required: ["day", "focus", "tasks"]
            }
        },
        title: {
            type: Type.STRING,
            description: "Job title inferred from the job description."
        }
    },
    required: [
        "matchScore",
        "technicalQuestions",
        "behavioralQuestions",
        "skillGaps",
        "preparationPlan",
        "title"
    ]
};

// ---------------------------------------------
// Retry temporary Gemini API errors
// ---------------------------------------------

async function generateWithRetry(request, maxAttempts = 4) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await ai.models.generateContent(request);
        } catch (error) {
            const status = Number(
                error.status ??
                error.code ??
                error.error?.code
            );

            const retryable =
                status === 429 ||
                status === 503 ||
                (status >= 500 && status <= 599);

            if (!retryable || attempt === maxAttempts) {
                throw error;
            }

            const delay =
                Math.min(1000 * (2 ** (attempt - 1)), 8000) +
                Math.floor(Math.random() * 500);

            console.warn(
                `Gemini error ${status}. Retrying in ${delay}ms.`
            );

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw new Error("Gemini request failed after all retry attempts.");
}

// ---------------------------------------------
// Generate interview report
// ---------------------------------------------

async function generateInterviewReport({
    resume,
    selfDescription,
    jobDescription
}) {
    if (
        typeof resume !== "string" ||
        !resume.trim() ||
        typeof selfDescription !== "string" ||
        !selfDescription.trim() ||
        typeof jobDescription !== "string" ||
        !jobDescription.trim()
    ) {
        throw new Error(
            "Resume, self-description, and job description must be non-empty strings."
        );
    }

    const prompt = `
You are an expert technical interviewer and career advisor.

Generate a personalized interview preparation report using the
candidate information below.

CANDIDATE RESUME:
${resume}

CANDIDATE SELF-DESCRIPTION:
${selfDescription}

TARGET JOB DESCRIPTION:
${jobDescription}

Requirements:
1. Calculate matchScore from 0 to 100 based on relevant skills,
   experience, education, and job requirements.
2. Generate useful technical interview questions.
3. Generate relevant behavioral interview questions.
4. For each question, explain the interviewer's intention and
   provide a practical answer guide tailored to the candidate.
5. Identify relevant skill gaps and assign low, medium, or high severity.
6. Create an actionable, day-wise preparation plan.
7. Infer the job title from the job description.
8. Do not invent candidate qualifications or experience.
9. Return all required fields in the response schema.
10. Return JSON only, without Markdown or code fences.
`;

    const response = await generateWithRetry({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: geminiInterviewSchema
        }
    });

    if (!response.text || !response.text.trim()) {
        throw new Error("Gemini returned an empty interview report.");
    }

    let parsed;

    try {
        parsed = JSON.parse(response.text);
    } catch {
        console.error("Invalid Gemini JSON response:", response.text);
        throw new Error("Gemini returned invalid JSON.");
    }

    // Validate only the fields that Gemini is responsible for.
    const generated = aiInterviewReportSchema.parse(parsed);

    // Add the original user inputs ourselves.
    // Gemini does not need to generate these fields.
    const completeReport = {
        jobDescription: jobDescription.trim(),
        resume: resume.trim(),
        selfDescription: selfDescription.trim(),
        ...generated
    };

    // Validate the exact object returned/saved by the application.
    return interviewReportSchema.parse(completeReport);
}

// ---------------------------------------------
// Generate PDF from HTML
// ---------------------------------------------

async function generatePdfFromHtml(htmlContent) {
    let browser;

    try {
        browser = await puppeteer.launch();

        const page = await browser.newPage();

        await page.setContent(htmlContent, {
            waitUntil: "networkidle0"
        });

        return await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            margin: {
                top: "20mm",
                bottom: "20mm",
                left: "15mm",
                right: "15mm"
            }
        });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// ---------------------------------------------
// Generate ATS-friendly resume PDF
// ---------------------------------------------

async function generateResumePdf({
    resume,
    selfDescription,
    jobDescription
}) {
    const prompt = `Generate resume for a candidate with the following details:
                        Resume: ${resume}
                        Self Description: ${selfDescription}
                        Job Description: ${jobDescription}

                        the response should be a JSON object with a single field "html" which contains the HTML content of the resume which can be converted to PDF using any library like puppeteer.
                        The resume should be tailored for the given job description and should highlight the candidate's strengths and relevant experience. The HTML content should be well-formatted and structured, making it easy to read and visually appealing.
                        The content of resume should be not sound like it's generated by AI and should be as close as possible to a real human-written resume.
                        you can highlight the content using some colors or different font styles but the overall design should be simple and professional.
                        The content should be ATS friendly, i.e. it should be easily parsable by ATS systems without losing important information.
                        The resume should not be so lengthy, it should ideally be 1-2 pages long when converted to PDF. Focus on quality rather than quantity and make sure to include all the relevant information that can increase the candidate's chances of getting an interview call for the given job description.`;

    const response = await generateWithRetry({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    html: { type: Type.STRING }
                },
                required: ["html"]
            }
        }
    });

    if (!response.text || !response.text.trim()) {
        throw new Error("Gemini returned an empty resume response.");
    }

    let parsed;

    try {
        parsed = JSON.parse(response.text);
    } catch {
        throw new Error("Gemini returned invalid resume JSON.");
    }

    const validated = resumePdfSchema.parse(parsed);

    if (!validated.html.trim()) {
        throw new Error("Gemini returned empty resume HTML.");
    }

    return generatePdfFromHtml(validated.html);
}

module.exports = {
    generateInterviewReport,
    generateResumePdf,
    generatePdfFromHtml
};
