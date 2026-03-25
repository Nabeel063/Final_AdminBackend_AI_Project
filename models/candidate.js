// models/Candidate.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import validator from "validator";

const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      validate: [validator.isEmail, "Invalid email"],
    },

    password: { type: String, required: true, minlength: 6, select: false },

    phone: { type: String, required: true },

    resume: { type: String,  },

    /** Used for job recommendations (comma-separated or saved from profile) */
    skills: { type: [String], default: [] },

    yearsOfExperience: { type: Number },

    /** Short text from resume / bio — matched against JD text */
    professionalSummary: { type: String, default: "" },

    avatar: { type: String },

    lastlogin: { type: Date },
    isActive: { type: Boolean, default: true },
    hasLoggedIn: { type: Boolean, default: false },
    resetPasswordOTP: { type: String },
    resetPasswordOTPExpiry: { type: Number },
  },
  { timestamps: true }
);

// hash password
candidateSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, await bcrypt.genSalt(10));
  next();
});

// compare password
candidateSchema.methods.matchPassword = function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.models.Candidate ||
  mongoose.model("Candidate", candidateSchema);
