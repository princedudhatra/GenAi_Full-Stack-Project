
const pdfParse = require("pdf-parse");

const {
    generateInterviewReport,
    generateResumePdf
} = require("../services/ai.service");

const interviewReportModel =
    require("../models/interviewReport.model");

// ---------------------------------------------
// Extract fields from request
// ---------------------------------------------

function getRequestFields(body = {}) {
    let fields = {};

    if (typeof body.formdata === "string") {
        try {
            fields = JSON.parse(body.formdata);
        } catch {
            throw new Error("Invalid JSON in formdata.");
        }
    } else if (
        body.formdata &&
        typeof body.formdata === "object" &&
        !Array.isArray(body.formdata)
    ) {
        fields = body.formdata;
    }

    // Individual body fields take precedence over formdata fields.
    return {
        ...fields,
        ...body,
        formdata: undefined
    };
}

// ---------------------------------------------
// Generate interview report
// ---------------------------------------------

async function generateInterViewReportController(req, res) {
    try {
        const fields = getRequestFields(req.body);

        const {
            selfDescription,
            jobDescription
        } = fields;

        let resumeText = fields.resume;

        // Extract text if a PDF file was uploaded.
        if (req.file) {
            if (!req.file.buffer) {
                return res.status(400).json({
                    message:
                        "Resume PDF buffer is missing. Configure Multer memory storage."
                });
            }

            const pdf = new pdfParse.PDFParse(
                Uint8Array.from(req.file.buffer)
            );

            try {
                const result = await pdf.getText();
                resumeText = result.text;
            } finally {
                if (typeof pdf.destroy === "function") {
                    await pdf.destroy();
                }
            }
        }

        if (
            typeof resumeText !== "string" ||
            !resumeText.trim()
        ) {
            return res.status(400).json({
                message: "Resume PDF or resume text is required."
            });
        }

        if (
            typeof selfDescription !== "string" ||
            !selfDescription.trim()
        ) {
            return res.status(400).json({
                message: "Self-description is required."
            });
        }

        if (
            typeof jobDescription !== "string" ||
            !jobDescription.trim()
        ) {
            return res.status(400).json({
                message: "Job description is required."
            });
        }

        if (!req.user?.id) {
            return res.status(401).json({
                message: "Please log in to generate an interview report."
            });
        }

        const reportData = await generateInterviewReport({
            resume: resumeText.trim(),
            selfDescription: selfDescription.trim(),
            jobDescription: jobDescription.trim()
        });

        const interviewReport =
            await interviewReportModel.create({
                ...reportData,
                user: req.user.id
            });

        return res.status(201).json({
            message: "Interview report generated successfully.",
            interviewReport
        });
    } catch (error) {
        console.error("Interview report generation failed:", error);

        const status = Number(
            error.status ??
            error.code ??
            error.error?.code
        );

        if (
            status === 429 ||
            status === 503 ||
            (status >= 500 && status <= 599)
        ) {
            return res.status(503).json({
                message:
                    "Gemini AI is temporarily unavailable. Please try again shortly."
            });
        }

        if (error.name === "ZodError") {
            return res.status(502).json({
                message:
                    "The generated report did not match the required format. Please try again.",
                details: error.issues
            });
        }

        if (
            error.message === "Invalid JSON in formdata."
        ) {
            return res.status(400).json({
                message: error.message
            });
        }

        return res.status(500).json({
            message: "Failed to generate interview report."
        });
    }
}

// ---------------------------------------------
// Get interview report by ID
// ---------------------------------------------

async function getInterviewReportByIdController(req, res) {
    try {
        const { interviewId } = req.params;

        const interviewReport =
            await interviewReportModel.findOne({
                _id: interviewId,
                user: req.user.id
            });

        if (!interviewReport) {
            return res.status(404).json({
                message: "Interview report not found."
            });
        }

        return res.status(200).json({
            message: "Interview report fetched successfully.",
            interviewReport
        });
    } catch (error) {
        console.error("Fetch interview report failed:", error);

        if (error.name === "CastError") {
            return res.status(400).json({
                message: "Invalid interview report ID."
            });
        }

        return res.status(500).json({
            message: "Failed to fetch interview report."
        });
    }
}

// ---------------------------------------------
// Get all reports belonging to logged-in user
// ---------------------------------------------

async function getAllInterviewReportsController(req, res) {
    try {
        const interviewReports =
            await interviewReportModel
                .find({ user: req.user.id })
                .sort({ createdAt: -1 })
                .select(
                    "-resume -selfDescription -jobDescription " +
                    "-__v -technicalQuestions -behavioralQuestions " +
                    "-skillGaps -preparationPlan"
                );

        return res.status(200).json({
            message: "Interview reports fetched successfully.",
            interviewReports
        });
    } catch (error) {
        console.error("Fetch interview reports failed:", error);

        return res.status(500).json({
            message: "Failed to fetch interview reports."
        });
    }
}

// ---------------------------------------------
// Generate tailored resume PDF
// ---------------------------------------------

async function generateResumePdfController(req, res) {
    try {
        const { interviewReportId } = req.params;

        // Only allow access to the logged-in user's report.
        const interviewReport =
            await interviewReportModel.findOne({
                _id: interviewReportId,
                user: req.user.id
            });

        if (!interviewReport) {
            return res.status(404).json({
                message: "Interview report not found."
            });
        }

        const pdfBuffer = await generateResumePdf({
            resume: interviewReport.resume,
            selfDescription: interviewReport.selfDescription,
            jobDescription: interviewReport.jobDescription
        });

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition":
                `attachment; filename="resume_${interviewReportId}.pdf"`,
            "Content-Length": pdfBuffer.length
        });

        return res.status(200).send(pdfBuffer);
    } catch (error) {
        console.error("Resume PDF generation failed:", error);

        const status = Number(
            error.status ??
            error.code ??
            error.error?.code
        );

        if (
            status === 429 ||
            status === 503 ||
            (status >= 500 && status <= 599)
        ) {
            return res.status(503).json({
                message:
                    "Gemini AI is temporarily unavailable. Please try again shortly."
            });
        }

        if (error.name === "CastError") {
            return res.status(400).json({
                message: "Invalid interview report ID."
            });
        }

        return res.status(500).json({
            message: "Failed to generate resume PDF."
        });
    }
}

module.exports = {
    generateInterViewReportController,
    getInterviewReportByIdController,
    getAllInterviewReportsController,
    generateResumePdfController
};
