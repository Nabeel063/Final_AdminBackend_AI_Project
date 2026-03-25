// Get candidate profile (self)
export const getCandidateProfile = asyncHandler(async (req, res, next) => {
  const candidateId = req.candidate._id;
  const candidate = await Candidate.findById(candidateId).select('-password');
  if (!candidate) return next(new errorResponse('Candidate not found', 404));
  res.status(200).json({ success: true, candidate });
});

// Update candidate profile (phone, resume file, skills, experience, summary)
export const updateCandidateProfile = asyncHandler(async (req, res, next) => {
  const candidateId = req.candidate._id;
  const { phone, skills, yearsOfExperience, professionalSummary } = req.body;
  let resumeUrl = null;
  if (req.file) {
    const uploadResult = await uploadBuffer(req.file.buffer, "candidates");
    resumeUrl = uploadResult.secure_url + `?v=${Date.now()}`;
  }
  const updateFields = {};
  if (phone) updateFields.phone = phone;
  if (resumeUrl) updateFields.resume = resumeUrl;
  if (skills !== undefined) updateFields.skills = parseSkillsFromBody(skills);
  if (yearsOfExperience !== undefined) {
    const raw = String(yearsOfExperience).trim();
    if (raw === "") updateFields.yearsOfExperience = null;
    else {
      const y = Number(raw);
      if (!Number.isNaN(y)) updateFields.yearsOfExperience = y;
    }
  }
  if (professionalSummary !== undefined) {
    updateFields.professionalSummary = String(professionalSummary || "").trim();
  }

  let candidate;
  if (Object.keys(updateFields).length > 0) {
    candidate = await Candidate.findByIdAndUpdate(candidateId, updateFields, {
      new: true,
      runValidators: true,
    }).select("-password");
  } else {
    candidate = await Candidate.findById(candidateId).select("-password");
  }
  if (!candidate) return next(new errorResponse("Candidate not found", 404));
  res.status(200).json({ success: true, candidate });
});
import Candidate from "../models/candidate.js";
import sendEmail from '../utils/sendEmail.js';
import { bulkJDTemplate } from '../utils/emailTemplates/bulkJDTemplate.js';
import { shortlistedCandidate } from '../utils/emailTemplates/bulkJDInviteTemplate.js';
/**
 * Send bulk JD invite emails to selected candidates for a new opening
 * Params: jdId (JobDescription id)
 * Body: { candidateIds: [array of candidate _id] }
 */
import JD from "../models/jobDescription.js";
import asyncHandler from "../utils/asyncHandler.js";
import mongoose from "mongoose";
import errorResponse from "../utils/errorResponse.js";
import cloudinary, { uploadBuffer } from "../utils/cloudinary.js";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { parseSkillsFromBody } from "../utils/candidateJobMatch.js";
import {
  buildResumeCompositeText,
  getCachedOrExtractProfile,
  rankJobsForCandidate,
  mapJdToFrontendCard,
  normalizeJdOfferForRanking,
  calculateMatchScore,
} from "../utils/resumeJobRecommendation.js";

// Register candidate
export const registerCandidate = asyncHandler(async (req, res, next) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password || !phone) return next(new errorResponse("All fields required", 400));
  const existing = await Candidate.findOne({ email });
  if (existing) return next(new errorResponse("Email already exists", 400));

  let resumeUrl = "";
  if (req.file && req.file.buffer) {
    // Upload resume to Cloudinary
    const uploadResult = await uploadBuffer(req.file.buffer, "candidates");
    resumeUrl = uploadResult.secure_url + `?v=${Date.now()}`;
  }

  const candidate = await Candidate.create({ name, email, password, phone, resume: resumeUrl });
  sendTokenResponse(candidate, 201, res);
});

// Login candidate
export const loginCandidate = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new errorResponse("Email and password required", 400));
  let candidate = await Candidate.findOne({ email }).select("+password");
  if (!candidate) return next(new errorResponse("Invalid credentials", 401));
  const isMatch = await candidate.matchPassword(password);
  if (!isMatch) return next(new errorResponse("Invalid credentials", 401));

  // Set hasLoggedIn to true on first login
  if (!candidate.hasLoggedIn) {
    candidate.hasLoggedIn = true;
    await candidate.save();
  }

  // Print all candidates in the table to the console
  const allCandidates = await Candidate.find();
  console.log('All candidates:', allCandidates);

  sendTokenResponse(candidate, 200, res);
});


export const applyJob = asyncHandler(async (req, res, next) => {
  const { jdId } = req.params;
  const { name, email, phone, reallocate, useExistingResume, existingResumeUrl } = req.body;

  let resumeUrl = null;
  if (useExistingResume === 'true' && existingResumeUrl) {
    resumeUrl = existingResumeUrl;
  } else {
    if (!req.file) {
      return next(new errorResponse("Resume file required", 400));
    }
    const uploadResult = await uploadBuffer(req.file.buffer, "candidates");
    resumeUrl = uploadResult.secure_url + `?v=${Date.now()}`;
  }

  const candidate = await Candidate.findOne({ email });
  if (!candidate) return next(new errorResponse("Candidate not found", 404));

  // 🔥 FIX — ALWAYS UPDATE CANDIDATE'S RESUME
  candidate.resume = resumeUrl;
  await candidate.save();

  // Fetch JD and populate offerId to get jobTitle
  const jd = await JD.findById(jdId).populate({ path: 'offerId', select: 'jobTitle' });
  if (!jd) return next(new errorResponse("JD not found", 404));

  // Get job title from Offer if available, else fallback to JD fields
  const jobTitle = jd.offerId?.jobTitle || jd.jobTitle || jd.title || jd.jobSummary || 'Job Opening';

  // Persist notification for recruiter (JD creator)
  const Notification = (await import('../models/notification.js')).default;
  await Notification.create({
    recipient: jd.createdBy,
    message: `New candidate applied: ${candidate.name} for ${jobTitle}`,
    link: `/jobs/${jd._id}`,
  });
  if (jd.appliedCandidates.some(c => c.candidate.toString() === candidate._id.toString())) {
    return next(new errorResponse("Already applied to this job", 400));
  }

  jd.appliedCandidates.push({
    candidate: candidate._id,
    resume: resumeUrl,
    name,
    email,
    phone,
    reallocate: reallocate === "yes" || reallocate === true,
    status: "applied",
  });

  await jd.save();

  // Emit notification to candidate and recruiter
  const io = req.app.get('io');
  if (io) {
    // Notify candidate
    io.to(candidate._id.toString()).emit('notification', {
      message: `You have successfully applied to: ${jobTitle}`,
      link: `/jobs/${jd._id}`,
      createdAt: new Date(),
    });
    // Notify recruiter (JD creator)
    io.to(jd.createdBy.toString()).emit('notification', {
      message: `New candidate applied: ${candidate.name} for ${jobTitle}`,
      link: `/jobs/${jd._id}`,
      createdAt: new Date(),
    });
  }

  res.status(201).json({
    success: true,
    message: "Applied successfully and notifications sent.",
  });
});


// Get all jobs applied by candidate
export const getAppliedJobs = asyncHandler(async (req, res, next) => {
  const candidateId = req.candidate._id;
  const jds = await JD.find({ "appliedCandidates.candidate": candidateId });
  res.json({ success: true, jobs: jds });
});

// Helper: send JWT
function sendTokenResponse(candidate, statusCode, res) {
  const payload = { id: candidate._id, role: "Candidate" };
  const token = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpire });
  res.status(statusCode).json({ success: true, token, candidate });
}

export const getAllCandidates = asyncHandler(async (req, res, next) => {
  const candidates = await Candidate.find();
  res.json({ success: true, candidates });
});

// Get candidate details by id
export const getCandidateById = asyncHandler(async (req, res, next) => {
  const candidateId = req.params.id;
  if (!candidateId) return next(new errorResponse('Candidate id is required', 400));

  let candidate = null;
  if (mongoose.Types.ObjectId.isValid(candidateId)) {
    candidate = await Candidate.findById(candidateId).select('-password');
  } else {
    // Fallback: attempt to find by alternate identifier fields (e.g., candidateId or email)
    candidate = await Candidate.findOne({ $or: [{ candidateId }, { email: candidateId }] }).select('-password');
  }

  if (!candidate) return next(new errorResponse('Candidate not found', 404));

  res.status(200).json({ success: true, candidate });
});

export const sendBulkJDInvite = asyncHandler(async (req, res, next) => {
  const { jdId } = req.params;
  const { candidateIds, startDate = '', startTime = '', endDate = '', endTime = '' } = req.body;
  if (!jdId) return next(new errorResponse('JD id is required', 400));

  // Fetch JD details
  const jd = await JD.findById(jdId);
  if (!jd) {
    return next(new errorResponse('Job Description not found', 404));
  }

  // Determine candidates to invite.
  let selectedCandidateIds = [];
  let alreadyInvitedCount = 0;
  let completedTestCount = 0;
  
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    // Filter provided candidateIds to exclude those with mailStatus "sent" or testCompletedAt
    selectedCandidateIds = candidateIds.filter(cId => {
      const appliedCandidate = jd.appliedCandidates.find(ac => 
        ac.candidate && ac.candidate.toString() === cId.toString()
      );
      
      // Track why candidates are excluded
      if (appliedCandidate) {
        if (appliedCandidate.mailStatus === 'sent') {
          alreadyInvitedCount++;
          return false;
        }
        if (appliedCandidate.testCompletedAt) {
          completedTestCount++;
          return false;
        }
      }
      
      // Include only if mailStatus is NOT "sent" AND testCompletedAt is NOT set
      return appliedCandidate && appliedCandidate.mailStatus !== 'sent' && !appliedCandidate.testCompletedAt;
    });
  } else {
    // Auto-select candidates who have status 'applied' or legacy 'pending' and
    // who applied after the last invite (if lastInviteAt exists) AND have not received invite yet
    const eligibleStatuses = ['applied', 'pending'];
    selectedCandidateIds = jd.appliedCandidates
      .filter(ac => {
        if (!eligibleStatuses.includes(ac.status) || (jd.lastInviteAt && ac.appliedAt && ac.appliedAt <= jd.lastInviteAt)) {
          return false;
        }
        
        if (ac.mailStatus === 'sent') {
          alreadyInvitedCount++;
          return false;
        }
        if (ac.testCompletedAt) {
          completedTestCount++;
          return false;
        }
        
        return true;
      })
      .map(ac => ac.candidate);
  }

  // If no eligible candidates, return a friendly message instead of error
  if (!selectedCandidateIds || selectedCandidateIds.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No new candidates to send job opening invite',
      jdId,
      sentCount: 0,
      alreadyInvitedCount,
      completedTestCount,
      detail: alreadyInvitedCount > 0 || completedTestCount > 0 
        ? `All candidates have either already received an invite (${alreadyInvitedCount}) or completed the test (${completedTestCount}).`
        : 'All eligible candidates have already been processed.'
    });
  }

  // Fetch candidate documents
  const candidates = await Candidate.find({ _id: { $in: selectedCandidateIds } });
  if (!candidates.length) {
    return res.status(200).json({
      success: true,
      message: 'No valid candidates found',
      jdId,
      sentCount: 0,
      alreadyInvitedCount,
      completedTestCount
    });
  }

  // Build apply URL (customize as needed)
  const applyUrl = `${process.env.FRONTEND_URL || 'http://103.192.198.240/CandidateLogin'}`;

  // Send emails
  let sentCount = 0;
  for (const candidate of candidates) {
    const html = bulkJDTemplate(
      candidate.name,
      jd.jobSummary || jd.title || jd.jobTitle || 'Job Opening',
      jd.companyName || 'Our Company',
      applyUrl
    );
    try {
      await sendEmail({
        to: candidate.email,
        subject: `New Opening: ${ jd.companyName || jd.jobTitle}`,
        html
      });
      sentCount++;
      // mark appliedCandidate entry as link_sent, set invitedAt, mailStatus, and mailSentAt
      const idx = jd.appliedCandidates.findIndex(ac => ac.candidate && ac.candidate.toString() === candidate._id.toString());
      if (idx !== -1) {
        jd.appliedCandidates[idx].status = 'link_sent';
        jd.appliedCandidates[idx].invitedAt = new Date();
        jd.appliedCandidates[idx].mailStatus = 'sent';
        jd.appliedCandidates[idx].mailSentAt = new Date();
      }
    } catch (e) {
      // Optionally log or collect failed emails
      const idx = jd.appliedCandidates.findIndex(ac => ac.candidate && ac.candidate.toString() === candidate._id.toString());
      if (idx !== -1) {
        jd.appliedCandidates[idx].mailStatus = 'failed';
      }
    }
  }

  // update JD lastInviteAt and save
  jd.lastInviteAt = new Date();
  await jd.save();

  res.status(200).json({
    success: true,
    message: `Bulk JD invites sent to ${sentCount} candidates.`,
    jdId,
    sentCount,
    alreadyInvitedCount,
    completedTestCount
  });
});


export const sendInviteToShortlisted = asyncHandler(async (req, res, next) => {
  const { jdId } = req.params;
  const { candidateIds, startDate = '', startTime = '', endDate = '', endTime = '' } = req.body;
  if (!jdId) return next(new errorResponse('JD id is required', 400));

  // Fetch JD details
  const jd = await JD.findById(jdId);
  if (!jd) {
    return next(new errorResponse('Job Description not found', 404));
  }

  // Determine candidates to invite. If candidateIds provided use them,
  // otherwise pick shortlisted/applied recent ones similar to bulk invite logic.
  let selectedCandidateIds = [];
  let alreadyInvitedCount = 0;
  let completedTestCount = 0;
  
  if (Array.isArray(candidateIds) && candidateIds.length > 0) {
    // Filter provided candidateIds to exclude those with mailStatus "sent" or testCompletedAt
    selectedCandidateIds = candidateIds.filter(cId => {
      const appliedCandidate = jd.appliedCandidates.find(ac => 
        ac.candidate && ac.candidate.toString() === cId.toString()
      );
      
      // Track why candidates are excluded
      if (appliedCandidate) {
        if (appliedCandidate.mailStatus === 'sent') {
          alreadyInvitedCount++;
          return false;
        }
        if (appliedCandidate.testCompletedAt) {
          completedTestCount++;
          return false;
        }
      }
      
      // Include only if mailStatus is NOT "sent" AND testCompletedAt is NOT set
      return appliedCandidate && appliedCandidate.mailStatus !== 'sent' && !appliedCandidate.testCompletedAt;
    });
  } else {
    const eligibleStatuses = ['applied', 'pending'];
    selectedCandidateIds = jd.appliedCandidates
      .filter(ac => {
        if (!eligibleStatuses.includes(ac.status) || (jd.lastInviteAt && ac.appliedAt && ac.appliedAt <= jd.lastInviteAt)) {
          return false;
        }
        
        if (ac.mailStatus === 'sent') {
          alreadyInvitedCount++;
          return false;
        }
        if (ac.testCompletedAt) {
          completedTestCount++;
          return false;
        }
        
        return true;
      })
      .map(ac => ac.candidate);
  }

  // If no eligible candidates, return a friendly message instead of error
  if (!selectedCandidateIds || selectedCandidateIds.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No new candidates to send test invite',
      jdId,
      sentCount: 0,
      alreadyInvitedCount,
      completedTestCount,
      detail: alreadyInvitedCount > 0 || completedTestCount > 0 
        ? `All candidates have either already received an invite (${alreadyInvitedCount}) or completed the test (${completedTestCount}).`
        : 'All eligible candidates have already been processed.'
    });
  }

  const candidates = await Candidate.find({ _id: { $in: selectedCandidateIds } });
  if (!candidates.length) {
    return res.status(200).json({
      success: true,
      message: 'No valid candidates found',
      jdId,
      sentCount: 0,
      alreadyInvitedCount,
      completedTestCount
    });
  }

  // Build apply URL (customize as needed)
  const applyUrl = `${process.env.FRONTEND_URL || 'http://103.192.198.240/CandidateLogin'}`;

  // Get jobTitle with proper fallback
  const jobTitle = jd.jobTitle || jd.title || jd.jobSummary || 'Job Opening';

  // Send emails
  let sentCount = 0;
  const sentCandidateIds = [];
  const failedCandidateIds = [];
  for (const candidate of candidates) {
    const html = shortlistedCandidate(
      candidate.name,
      jobTitle,
      jd.companyName || 'Our Company',
      applyUrl,
      startDate,
      startTime,
      endDate,
      endTime
    );
    try {
      await sendEmail({
        to: candidate.email,
        subject: `Congratulations! Your Examination is Scheduled - ${jobTitle}`,
        html
      });
      sentCount++;
      sentCandidateIds.push(candidate._id.toString());
      // mark appliedCandidate entry as link_sent, set invitedAt, mailStatus, and mailSentAt
      const idx = jd.appliedCandidates.findIndex(ac => ac.candidate && ac.candidate.toString() === candidate._id.toString());
      if (idx !== -1) {
        jd.appliedCandidates[idx].status = 'link_sent';
        jd.appliedCandidates[idx].invitedAt = new Date();
        jd.appliedCandidates[idx].mailStatus = 'sent';
        jd.appliedCandidates[idx].mailSentAt = new Date();
      }
    } catch (e) {
      // Optionally log or collect failed emails
      const idx = jd.appliedCandidates.findIndex(ac => ac.candidate && ac.candidate.toString() === candidate._id.toString());
      if (idx !== -1) {
        jd.appliedCandidates[idx].mailStatus = 'failed';
      }
      failedCandidateIds.push(candidate._id.toString());
    }
  }

  // update JD lastInviteAt and save
  jd.lastInviteAt = new Date();
  await jd.save();

  res.status(200).json({
    success: true,
    message: `Test invites sent to ${sentCount} candidate(s).`,
    jdId,
    sentCount,
    alreadyInvitedCount,
    completedTestCount
    , attempted: selectedCandidateIds.map(id => id.toString()),
    sentCandidateIds,
    failedCandidateIds
  });
});



export const getCandidateJdCounts = asyncHandler(async (req, res, next) => {
  try {
    const candidateId = req.candidate._id;
    const [totalAppliedJds, filteredJds, unfilteredJds] = await Promise.all([
      JD.countDocuments({ "appliedCandidates.candidate": candidateId }),
      JD.countDocuments({ "filteredCandidates.candidate": candidateId }),
      JD.countDocuments({ "unfilteredCandidates.candidate": candidateId })
    ]);

    res.status(200).json({
      success: true,
      counts: {
        totalAppliedJds,
        filteredJds,
        unfilteredJds
      }
    });

  } catch (err) {
    return next(
      new errorResponse(err.message || "Failed to fetch JD counts", 500)
    );
  }
});

/**
 * GET /api/candidate/me/job-recommendations  (uses JWT only — preferred for UI)
 * GET /api/candidate/recommend-jobs  (legacy)
 * GET /api/candidate/recommend-jobs/:candidateId  (must equal JWT user)
 * GET /api/candidate/:mongoObjectId  (HR `protect` only if param is a valid ObjectId; literals like recommend-jobs never hit User JWT)
 * Resume-aware matching: skills (50%) + experience (30%) + TF‑IDF cosine vs JD (20%).
 * Returns up to 8 best matches; prefers jobs ≥ 50% when any exist.
 */
export const recommendJobsForCandidate = asyncHandler(async (req, res, next) => {
  try {
    const paramId = req.params.candidateId;
    if (paramId != null && String(paramId) !== String(req.candidate._id)) {
      return next(new errorResponse("Forbidden", 403));
    }

    const candidateId = req.candidate._id;
    const candidate = await Candidate.findById(candidateId).select("-password").lean();
    if (!candidate) {
      return next(new errorResponse("Candidate not found", 404));
    }

    const composite = buildResumeCompositeText(candidate);
    const hasSignals =
      String(composite).trim().length >= 2 ||
      (Array.isArray(candidate.skills) && candidate.skills.length > 0) ||
      (candidate.yearsOfExperience != null && !Number.isNaN(Number(candidate.yearsOfExperience))) ||
      (candidate.resume && String(candidate.resume).trim().length > 0) ||
      (candidate.professionalSummary && String(candidate.professionalSummary).trim().length > 0);

    if (!hasSignals) {
      return res.status(200).json({
        success: true,
        candidateId: String(candidateId),
        resumeInsights: null,
        recommendedJobs: [],
        message:
          "Add skills, a professional summary, or upload a resume in your profile to get personalized recommendations.",
      });
    }

    const profile = getCachedOrExtractProfile(candidate);

    const now = new Date();
    const dueCutoff = new Date(now);
    dueCutoff.setUTCDate(dueCutoff.getUTCDate() - 30);

    const agg = await JD.aggregate([
      {
        $lookup: {
          from: "offers",
          localField: "offerId",
          foreignField: "_id",
          as: "offerObj",
        },
      },
      { $unwind: "$offerObj" },
      {
        $match: {
          "offerObj.dueDate": { $gte: dueCutoff },
        },
      },
    ]);

    const populated = await JD.populate(agg, [
      { path: "createdBy", select: "name email" },
      { path: "offerId" },
    ]);

    const normalized = populated.map((jd) => normalizeJdOfferForRanking(jd));

    const notApplied = normalized.filter(
      (jd) =>
        !(jd.appliedCandidates || []).some(
          (ac) => ac.candidate && String(ac.candidate) === String(candidateId)
        )
    );

    let ranked = rankJobsForCandidate(profile, notApplied, {
      minMatchPreferred: 50,
      minMatchFloor: 0,
      limit: 8,
    });

    if (ranked.length === 0 && notApplied.length > 0) {
      ranked = notApplied.slice(0, 8).map((jd) => {
        const jdN = normalizeJdOfferForRanking(jd);
        const offer = jdN.offerId;
        const rec = offer
          ? calculateMatchScore(profile, jdN, offer)
          : {
              matchPercentage: 15,
              skillScore: 0,
              experienceScore: 0.5,
              similarityScore: 0,
              matchedSkills: [],
              missingSkills: [],
              experienceMatch: false,
              reason: "Open role — add skills to your profile for a stronger match score",
            };
        return { jd: jdN, rec };
      });
    }

    const recommendedJobs = ranked.map(({ jd, rec }) => {
      const offer = jd.offerId || {};
      const card = mapJdToFrontendCard(jd, rec);
      return {
        jobTitle: offer.jobTitle || jd.jobSummary || "Job Opening",
        jdId: String(jd._id),
        matchPercentage: rec.matchPercentage,
        matchedSkills: rec.matchedSkills,
        missingSkills: rec.missingSkills,
        experienceMatch: rec.experienceMatch,
        reason: rec.reason,
        companyName: card.company,
        mappedJob: card,
      };
    });

    res.status(200).json({
      success: true,
      candidateId: String(candidateId),
      resumeInsights: {
        skills: profile.skills,
        experienceYears: profile.experienceYears,
        roles: profile.roles,
        projects: profile.projects,
        technologies: profile.technologies,
        domains: profile.domains,
      },
      recommendedJobs,
    });
  } catch (err) {
    return next(
      new errorResponse(err.message || "Failed to fetch job recommendations", 500)
    );
  }
});

export const showlatestFiveJdsForCandidate = asyncHandler(async (req, res, next) => {
  try {
    const candidateId = req.candidate._id;
    const jds = await JD.find({ "appliedCandidates.candidate": candidateId })
      .sort({ createdAt: -1 })
      .limit(5);
    res.status(200).json({ success: true, data: jds });
  } catch (err) {
    return next(
      new errorResponse(err.message || "Failed to fetch latest JDs", 500)
    );
  }
});

export const getAppliedjd = asyncHandler(async (req, res, next) => {
  try {
    const candidateId = req.candidate._id;
    // Populate offerId to get jobTitle from Offer model
    const jds = await JD.find({ "appliedCandidates.candidate": candidateId })
      .populate({ path: "offerId", select: "jobTitle" })
      .select("jobSummary companyName responsibilities requirements benefits additionalNotes appliedCandidates offerId createdAt");
    // Map to include jobTitle from offerId, createdAt, and applied date from appliedCandidates
    const result = jds.map(jd => {
      const appliedCandidate = jd.appliedCandidates.find(
        (ac) => ac.candidate.toString() === candidateId.toString()
      );
      return {
        ...jd.toObject(),
        jobTitle: jd.offerId?.jobTitle || null,
        jobSummary: jd.jobSummary || null,
        createdAt: jd.createdAt,
        appliedDate: appliedCandidate?.appliedAt || null
      };
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    return next(
      new errorResponse(err.message || "Failed to fetch applied JDs", 500)
    );
  }
});

export const getCandidateResume = asyncHandler(async (req, res, next) => {
  try {
    const candidateId = req.candidate._id;
    const candidate = await Candidate.findById(candidateId).select("resume");
    if (!candidate || !candidate.resume) {
      return next(new errorResponse("Resume not found", 404));
    }
    res.status(200).json({ success: true, resume: candidate.resume });
  } catch (err) {
    return next(
      new errorResponse(err.message || "Failed to fetch resume", 500)
    );
  }
});

// export const getlatestJdsForCandidate = asyncHandler(async (req, res, next) => {
//   try {
//     const candidateId = req.user._id;
//     const jds = await JD.find({ "appliedCandidates.candidate": candidateId })
//       .sort({ createdAt: -1 })
//       .limit(5);
//     res.status(200).json({ success: true, data: jds });
//   } catch (err) {
//     return next(
//       new errorResponse(err.message || "Failed to fetch latest JDs", 500)
//     );
//   }
// });
export const markTestCompleted = asyncHandler(async (req, res, next) => {
  const { jdId } = req.params;
  const { candidateId, email } = req.body;

  if (!jdId) {
    return next(new errorResponse('JD id is required', 400));
  }

  if (!candidateId && !email) {
    return next(new errorResponse('Either candidateId or email is required', 400));
  }

  // Fetch JD
  const jd = await JD.findById(jdId);
  if (!jd) {
    return next(new errorResponse('Job Description not found', 404));
  }

  // Find the candidate in appliedCandidates
  let candidateIndex = -1;
  if (candidateId) {
    candidateIndex = jd.appliedCandidates.findIndex(
      ac => ac.candidate && ac.candidate.toString() === candidateId
    );
  } else if (email) {
    candidateIndex = jd.appliedCandidates.findIndex(
      ac => ac.email === email
    );
  }

  if (candidateIndex === -1) {
    return next(new errorResponse('Candidate not found in this job application', 404));
  }

  // Update testCompletedAt and status to completed
  jd.appliedCandidates[candidateIndex].testCompletedAt = new Date();
  jd.appliedCandidates[candidateIndex].status = 'completed';

  await jd.save();

  res.status(200).json({
    success: true,
    message: 'Test marked as completed',
    jdId,
    candidateId: jd.appliedCandidates[candidateIndex].candidate,
  });
});

// Apply for a job (JD)
// export const applyJob = asyncHandler(async (req, res, next) => {
//   const { jdId } = req.params;
//   const { name, email, phone, reallocate } = req.body;
//   if (!req.files || !req.files.resume) return next(new errorResponse("Resume file required", 400));
//   const resumeFile = req.files.resume;
//   const resumeUrl = await cloudinary.uploader.upload(resumeFile.tempFilePath, { folder: 'candidates' });
//   const candidate = await Candidate.findOne({ email });
//   if (!candidate) return next(new errorResponse("Candidate not found", 404));
//   const jd = await JD.findById(jdId);
//   if (!jd) return next(new errorResponse("JD not found", 404));
//   // Prevent duplicate application
//   if (jd.appliedCandidates.some(c => c.candidate.toString() === candidate._id.toString())) {
//     return next(new errorResponse("Already applied to this job", 400));
//   }
//   jd.appliedCandidates.push({
//     candidate: candidate._id,
//     resume: resumeUrl,
//     name,
//     email,
//     phone,
//     reallocate: reallocate === "yes" || reallocate === true,
//     status: "pending",
//   });
//   await jd.save();
//   res.status(201).json({ success: true, message: "Applied successfully" });
// });