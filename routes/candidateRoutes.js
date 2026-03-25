import { getCandidateProfile, updateCandidateProfile } from "../controllers/candidateController.js";
// Candidate profile routes
import express from "express";
import {getCandidateById, sendBulkJDInvite, registerCandidate, loginCandidate, applyJob, getAppliedJobs, getCandidateJdCounts, showlatestFiveJdsForCandidate, getAppliedjd, getCandidateResume, sendInviteToShortlisted, markTestCompleted, recommendJobsForCandidate} from "../controllers/candidateController.js";
// import { registerCandidate, loginCandidate, applyJob, getAppliedJobs} from "../controllers/candidateController.js";
import { protect } from "../middlewares/auth.js";
import { protectCandidate } from "../middlewares/authCandidate.js";
import errorResponse from "../utils/errorResponse.js";
import multer from "multer";

/** Strict 24-hex id only — stricter than mongoose.isValid (avoids edge-case true positives). */
function isMongoObjectIdString(s) {
  return typeof s === "string" && /^[a-fA-F0-9]{24}$/.test(s);
}

const router = express.Router();
const upload = multer();

// Literal routes before any `/:id` (HR). Invalid ObjectIds must not hit `protect` (would 401 on candidate JWT).
router.get("/me/job-recommendations", protectCandidate, recommendJobsForCandidate);
router.get(["/recommend-jobs", "/recommend-jobs/"], protectCandidate, recommendJobsForCandidate);
router.get("/recommend-jobs/:candidateId", protectCandidate, recommendJobsForCandidate);

router.post("/register", upload.single("resume"), registerCandidate);
router.post("/login", loginCandidate);
router.post("/apply/:jdId", upload.single("resume"), applyJob);
router.get("/profile/me", protectCandidate, getCandidateProfile);
router.put("/profile/me", protectCandidate, upload.single("resume"), updateCandidateProfile);
router.get("/applied-jobs", protectCandidate, getAppliedJobs);
router.get("/jd-counts", protectCandidate, getCandidateJdCounts);
router.get("/latest-five-jds", protectCandidate, showlatestFiveJdsForCandidate);
router.get("/applied-jds", protectCandidate, getAppliedjd);
router.post("/send-email/:jdId", protect, sendBulkJDInvite);
router.post("/send-email-shortlisted/:jdId", protect, sendInviteToShortlisted);
router.post("/mark-test-completed/:jdId", markTestCompleted);
// Get candidate by id (protected)

router.get("/resume", protectCandidate, getCandidateResume);

// Public candidate lookup (no auth)
router.get("/public/:id", getCandidateById);

// HR/Admin: legacy GET /candidate/:id — only strict ObjectId strings (never literals like recommend-jobs)
router.get(
  "/:id",
  (req, res, next) => {
    const id = req.params.id;
    if (!isMongoObjectIdString(id)) {
      return next(new errorResponse("Not Found", 404));
    }
    next();
  },
  protect,
  getCandidateById
);

export default router;
