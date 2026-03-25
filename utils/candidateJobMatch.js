/** Token overlap + skill / experience heuristics for JD ↔ candidate profile matching */

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "has", "are", "was", "were",
  "been", "being", "will", "your", "our", "you", "all", "any", "can", "may", "not", "but",
  "into", "such", "also", "via", "per", "etc", "using", "used", "use", "work", "team", "role",
]);

export function parseJobExperienceRange(expStr) {
  if (!expStr) return { min: 0, max: 40 };
  const s = String(expStr).toLowerCase();
  if (/fresher|fresh\s*grad|entry\s*level|intern|trainee/.test(s)) return { min: 0, max: 1 };
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return { min: 0, max: 40 };
  const n = nums.map((x) => parseFloat(x));
  if (n.length >= 2) return { min: Math.min(n[0], n[1]), max: Math.max(n[0], n[1]) };
  if (/\+|more|above|minimum|min|least/.test(s)) return { min: n[0], max: 40 };
  return { min: Math.max(0, n[0] - 1), max: n[0] + 2 };
}

export function experienceFitScore(candidateYears, offerExpStr) {
  if (candidateYears == null || candidateYears === "" || Number.isNaN(Number(candidateYears))) {
    return 50;
  }
  const y = Number(candidateYears);
  const { min, max } = parseJobExperienceRange(offerExpStr);
  if (y < min) return Math.max(15, 100 - (min - y) * 12);
  if (y > max + 5) return 88;
  return 100;
}

export function normalizeSkillList(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length >= 2);
}

export function parseSkillsFromBody(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return normalizeSkillList(raw);
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return normalizeSkillList(j);
  } catch {
    /* comma-separated */
  }
  return normalizeSkillList(s.split(/[,;|]/).map((x) => x.trim()));
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s+#.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function buildJobSearchBlob(jd, offer) {
  const parts = [
    jd.jobSummary,
    jd.keyResponsibilities,
    jd.requiredQualifications,
    jd.additionalInfo,
    jd.additionalNotes,
    ...(jd.responsibilities || []),
    ...(jd.requirements || []),
    ...(jd.benefits || []),
    offer?.jobTitle,
    offer?.description,
    ...(offer?.skills || []),
    ...(offer?.preferredSkills || []),
    offer?.experience,
  ];
  return parts.filter(Boolean).join(" \n ").toLowerCase();
}

function skillOverlapScore(candidateSkills, jd, offer, blob) {
  if (!candidateSkills.length) return 0;
  let hits = 0;
  const reqLines = [...(jd.requirements || []), ...(jd.responsibilities || [])].map((x) =>
    String(x).toLowerCase()
  );
  const offerSkillLower = [
    ...(offer?.skills || []),
    ...(offer?.preferredSkills || []),
  ].map((x) => String(x).toLowerCase());

  for (const skill of candidateSkills) {
    if (!skill) continue;
    const inBlob = blob.includes(skill);
    const inReq = reqLines.some((line) => line.includes(skill));
    const inOfferSkills = offerSkillLower.some(
      (os) => os.includes(skill) || skill.includes(os) || os === skill
    );
    if (inBlob || inReq || inOfferSkills) hits += 1;
  }
  return Math.min(100, (hits / candidateSkills.length) * 100);
}

function textOverlapScore(professionalSummary, blob) {
  const summary = String(professionalSummary || "").trim();
  if (!summary) return 0;
  const tokens = [...new Set(tokenize(summary))];
  if (!tokens.length) return 0;
  let hit = 0;
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (blob.includes(t)) hit += 1;
  }
  return Math.min(100, (hit / tokens.length) * 100);
}

export function scoreJdForCandidate(candidate, jd, offer) {
  const skills = normalizeSkillList(candidate.skills || []);
  const blob = buildJobSearchBlob(jd, offer);
  const skillScore = skillOverlapScore(skills, jd, offer, blob);
  const expScore = experienceFitScore(candidate.yearsOfExperience, offer?.experience);
  const textScore = textOverlapScore(candidate.professionalSummary, blob);

  const hasSkills = skills.length > 0;
  const hasSummary = !!(candidate.professionalSummary && String(candidate.professionalSummary).trim());
  const hasYears =
    candidate.yearsOfExperience != null &&
    candidate.yearsOfExperience !== "" &&
    !Number.isNaN(Number(candidate.yearsOfExperience));

  let weighted;
  if (hasSkills && hasSummary) {
    weighted = skillScore * 0.42 + expScore * 0.28 + textScore * 0.3;
  } else if (hasSkills) {
    weighted = skillScore * 0.55 + expScore * 0.35 + textScore * 0.1;
  } else if (hasSummary) {
    weighted = skillScore * 0.15 + expScore * 0.3 + textScore * 0.55;
  } else if (hasYears) {
    weighted = skillScore * 0.2 + expScore * 0.65 + textScore * 0.15;
  } else {
    weighted = skillScore * 0.34 + expScore * 0.33 + textScore * 0.33;
  }

  const reasons = [];
  if (skillScore >= 40 && hasSkills) reasons.push("Skills align with this role");
  if (expScore >= 80 && hasYears) reasons.push("Experience level fits");
  if (textScore >= 35 && hasSummary) reasons.push("Profile text matches the job description");

  return {
    matchScore: Math.round(weighted * 10) / 10,
    skillScore: Math.round(skillScore * 10) / 10,
    expScore: Math.round(expScore * 10) / 10,
    textScore: Math.round(textScore * 10) / 10,
    reasons,
  };
}

export function candidateHasMatchProfile(candidate) {
  const skills = normalizeSkillList(candidate.skills || []);
  const summary = !!(candidate.professionalSummary && String(candidate.professionalSummary).trim());
  const years =
    candidate.yearsOfExperience != null &&
    candidate.yearsOfExperience !== "" &&
    !Number.isNaN(Number(candidate.yearsOfExperience));
  return skills.length > 0 || summary || years;
}
