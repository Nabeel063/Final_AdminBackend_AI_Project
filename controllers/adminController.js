// controllers/adminController.js
import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';
import generatePassword from '../utils/generatePassword.js';
import sendEmail from '../utils/sendEmail.js';
import { roles } from '../models/User.js';

/**
 * Admin registers a single RMG for a company.
 * - Only one RMG allowed per company.
 * Body: { name, email, company }  // company = ObjectId (or string if you use string)
 */
export const registerRMG = asyncHandler(async (req, res, next) => {
  const { name, email, company } = req.body;

  if (!name || !email || !company) {
    return next(new ErrorResponse('Please provide name, email and company', 400));
  }

  // ensure role email unique
  const existing = await User.findOne({ email });
  if (existing) return next(new ErrorResponse('Email already registered', 400));

  // ensure only one RMG exists in the system
  const existingAnyRMG = await User.findOne({ role: 'RMG' });
  if (existingAnyRMG) return next(new ErrorResponse('An RMG already exists. Only one RMG can be registered.', 400));

  // generate secure password
  const password = generatePassword();

  // create user in a transaction (safe)
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.create(
      [
        {
          name,
          email,
          password,
          role: 'RMG',
          company,
        },
      ],
      { session }
    );

    // send credentials email
    await sendEmail({
      to: email,
      subject: 'Your RMG account has been created',
      html: buildCredentialEmails(name, email, password, 'RMG'),
    });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({ success: true, message: 'RMG created and email sent', data: { id: user[0]._id, email } });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return next(new ErrorResponse(err.message || 'Failed to create RMG', 500));
  }
});

/**
 * Admin registers an HR user (multiple allowed).
 * Body: { name, email, company }
 */

// export const getAllRMG = async(async (req, res, next) => {
//   try {
//     const rmgUsers = await User.find({ role: 'RMG' }).select('-password');
//     res.status(200).json({ success: true, count: rmgUsers.length, data: rmgUsers });
//   }
//   catch (err) {
//     return next(new ErrorResponse(err.message || 'Failed to fetch RMGs', 500));
//   }
// });
export const getAllRMG = async (req, res, next) => {
  try {
    const rmgUsers = await User.find({ role: 'RMG' }).select('-password');
    res.status(200).json({ success: true, count: rmgUsers.length, data: rmgUsers });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to fetch RMGs', 500));
  }
};

export const updateLastLogin = asyncHandler(async (req, res, next) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdAndUpdate(
      userId,
      { lastlogin: new Date() },
      { new: true }
    );

    if (!user) {
      return next(new ErrorResponse('User not found', 404));
    }

    res.status(200).json({ success: true, message: 'Last login updated', data: user });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to update last login', 500));
  }
});

export const updateRmg = asyncHandler(async (req, res, next) => {
  try {
    const rmgId = req.params.id;
    const updates = req.body;

    const rmgUser = await User.findOneAndUpdate(
      { _id: rmgId, role: 'RMG' },
      updates,
      { new: true }
    ).select('-password');

    if (!rmgUser) {
      return next(new ErrorResponse('RMG user not found', 404));
    }

    res.status(200).json({ success: true, message: 'RMG updated', data: rmgUser });
  }
  catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to update RMG', 500));
  }
});

export const updateAdmin = asyncHandler(async (req, res, next) => {
  try {
    const adminId = req.params.id;
    const updates = req.body;

    const adminUser = await User.findOneAndUpdate(
      { _id: adminId, role: 'Admin' },
      updates,
      { new: true }
    ).select('-password');

    if (!adminUser) {
      return next(new ErrorResponse('Admin user not found', 404));
    }

    res.status(200).json({ success: true, message: 'Admin updated', data: adminUser });
  }
  catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to update Admin', 500));
  }
});

export const deleteRmg = asyncHandler(async (req, res, next) => {
  try {
    const rmgId = req.params.id;

    const rmgUser = await User.findOneAndDelete(
      { _id: rmgId, role: 'RMG' }
    );

    if (!rmgUser) {
      return next(new ErrorResponse('RMG user not found', 404));
    }

    res.status(200).json({ success: true, message: 'RMG deleted' });
  }
  catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to delete RMG', 500));
  }
});


export const registerHR = asyncHandler(async (req, res, next) => {
  const { name, phone, email, company } = req.body;
  if (!name || !phone || !email || !company) {
    return next(new ErrorResponse('Please provide name, email and company', 400));
  }

  const existing = await User.findOne({ email });
  if (existing) return next(new ErrorResponse('Email already registered', 400));

  const password = generatePassword();

  try {
    const user = await User.create({ name, phone, email, password, role: 'HR', company });

    await sendEmail({
      to: email,
      subject: 'Your HR account has been created',
      html: buildCredentialEmail(name, phone, email, password, 'HR'),
    });

    res.status(201).json({ success: true, message: 'HR created and email sent', data: { id: user._id, email } });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to create HR', 500));
  }
});

/* Helper to build HTML credential email */
const buildCredentialEmail = (name, number, email, password, role) => {
  const loginUrl = 'https://recruterai.netfotech.in/login';
  const companyLine = `<p style="margin:0">Role: <strong>${role}</strong></p>`;

  return `
  <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height:1.5;">
    <div style="max-width:600px;margin:0 auto;border:1px solid #e6eef8;padding:28px;border-radius:8px;">
      <h2 style="margin-top:0;color:#0b5fff">Welcome to Recruiter Portal</h2>
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your account has been created by your Company Admin. Use the credentials below to sign in:</p>

      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9;width:30%">Email</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${email}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9;width:30%">Number</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${number}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9">Password</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${password}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9">Role</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${role}</td>
        </tr>
      </table>

      <p style="margin-top:18px">For security, please change your password after first login. You can login here:</p>

      <p style="text-align:center;margin:20px 0">
        <a href="${loginUrl}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#0b5fff;color:#fff;text-decoration:none">Go to Login</a>
      </p>

      <hr style="border:none;border-top:1px solid #eef2ff;margin:18px 0"/>
      <p style="color:#475569;font-size:13px;margin:0">If you didn’t expect this email, please contact your company administrator.</p>
      <p style="color:#94a3b8;font-size:12px;margin:12px 0 0">© ${new Date().getFullYear()} Recruiter Portal</p>
    </div>
  </div>
  `;
};

const buildCredentialEmails = (name, email, password, role) => {
  const loginUrl = 'https://recruterai.netfotech.in/login';
  const companyLine = `<p style="margin:0">Role: <strong>${role}</strong></p>`;

  return `
  <div style="font-family: Inter, Arial, sans-serif; color: #0f172a; line-height:1.5;">
    <div style="max-width:600px;margin:0 auto;border:1px solid #e6eef8;padding:28px;border-radius:8px;">
      <h2 style="margin-top:0;color:#0b5fff">Welcome to Recruiter Portal</h2>
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your account has been created by your Company Admin. Use the credentials below to sign in:</p>

      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9;width:30%">Email</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${email}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9">Password</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${password}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #f1f5f9">Role</td>
          <td style="padding:8px;border:1px solid #f1f5f9">${role}</td>
        </tr>
      </table>

      <p style="margin-top:18px">For security, please change your password after first login. You can login here:</p>

      <p style="text-align:center;margin:20px 0">
        <a href="${loginUrl}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#0b5fff;color:#fff;text-decoration:none">Go to Login</a>
      </p>

      <hr style="border:none;border-top:1px solid #eef2ff;margin:18px 0"/>
      <p style="color:#475569;font-size:13px;margin:0">If you didn’t expect this email, please contact your company administrator.</p>
      <p style="color:#94a3b8;font-size:12px;margin:12px 0 0">© ${new Date().getFullYear()} Recruiter Portal</p>
    </div>
  </div>
  `;
};

export const getAllHR = asyncHandler(async (req, res, next) => {
  try {
    const recruiters = await User.find({ role: { $in: ['HR'] } }).select('-password');
    res.status(200).json({ success: true, count: recruiters.length, data: recruiters });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to fetch recruiters', 500));
  }
});


export const getAllHrAccordingtoComapny = asyncHandler(async (req, res, next) => {
  try {
    const companyId = req.user.company;
    console.log("comapny hard", companyId);

    const recruiters = await User.find({ role: { $in: ['HR'] }, company: companyId }).select('-password');
    res.status(200).json({ success: true, count: recruiters.length, data: recruiters });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to fetch recruiters', 500));
  }
});

export const getRecruiterById = asyncHandler(async (req, res, next) => {
  try {
    const recruiterId = req.params.id;
    const recruiter = await User.findById(recruiterId).select('-password');

    if (!recruiter || !['HR'].includes(recruiter.role)) {
      return next(new ErrorResponse('Recruiter not found', 404));
    }

    res.status(200).json({ success: true, data: recruiter });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to fetch recruiter', 500));
  }
});


export const deleteHR = asyncHandler(async (req, res, next) => {
  try {
    const hrId = req.params.id;

    const hrUser = await User.findOneAndDelete(
      { _id: hrId, role: 'HR' }
    );

    if (!hrUser) {
      return next(new ErrorResponse('HR user not found', 404));
    }

    res.status(200).json({ success: true, message: 'HR deleted' });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to delete HR', 500));
  }
});

export const updateHR = asyncHandler(async (req, res, next) => {
  try {
    const hrId = req.params.id;
    const updates = req.body;

    const hrUser = await User.findOneAndUpdate(
      { _id: hrId, role: 'HR' },
      updates,
      { new: true }
    ).select('-password');
    if (!hrUser) {
      return next(new ErrorResponse('HR user not found', 404));
    }

    res.status(200).json({ success: true, message: 'HR updated', data: hrUser });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to update HR', 500));
  }
});


export const getHrCreatedByRmg = asyncHandler(async (req, res, next) => {
  try {
    const rmgId = req.user._id;
    const hrUsers = await User.find({ role: 'HR', createdBy: rmgId }).select('-password');
    res.status(200).json({ success: true, count: hrUsers.length, data: hrUsers });
  } catch (err) {
    return next(new ErrorResponse(err.message || 'Failed to fetch HR users', 500));
  }
});


