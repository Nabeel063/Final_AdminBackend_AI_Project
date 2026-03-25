/**
 * Resume → structured profile + weighted job matching (skills / experience / TF‑IDF cosine).
 */
import crypto from "crypto";
import natural from "natural";
import { parseJobExperienceRange } from "./candidateJobMatch.js";

const tokenizer = new natural.WordTokenizer();
const stem = (w) => natural.PorterStemmer.stem(String(w).toLowerCase());

const EXTRA_STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "has", "are", "was", "were",
  "been", "being", "will", "your", "our", "you", "all", "any", "can", "may", "not", "but",
  "into", "such", "also", "via", "per", "etc", "using", "used", "use", "work", "team", "role",
  "job", "company", "years", "year", "experience", "skills", "project", "projects",
]);

/** Curated skill / tech phrases (longer first for safer substring checks). */
export const PREDEFINED_SKILLS = [
  "machine learning", "deep learning", "data science", "artificial intelligence", "computer vision",
  "natural language processing", "nlp", "large language model", "llm", "generative ai",
  "business intelligence", "power bi", "tableau", "looker",
  "node.js", "express.js", "nestjs", "next.js", "nuxt.js", "vue.js", "react.js", "angular.js",
  "typescript", "javascript", "ecmascript", "html5", "css3", "sass", "scss", "tailwind css",
  "bootstrap", "material ui", "mui", "redux", "zustand", "react query", "tanstack",
  "graphql", "rest api", "grpc", "websocket", "socket.io",
  "mongodb", "mongoose", "postgresql", "postgres", "mysql", "mariadb", "redis", "elasticsearch",
  "dynamodb", "cassandra", "firebase", "supabase", "sqlite",
  "aws", "azure", "gcp", "google cloud", "docker", "kubernetes", "k8s", "terraform", "ansible",
  "jenkins", "github actions", "gitlab ci", "circleci", "ci/cd",
  "microservices", "serverless", "lambda", "kafka", "rabbitmq", "apache kafka",
  "python", "django", "flask", "fastapi", "pandas", "numpy", "scikit-learn", "tensorflow", "pytorch",
  "java", "spring boot", "springboot", "hibernate", "kotlin", "scala",
  "c#", "csharp", ".net", "asp.net", "entity framework",
  "go", "golang", "rust", "c++", "cpp", "c", "ruby", "rails", "ruby on rails",
  "php", "laravel", "symfony", "wordpress",
  "swift", "objective-c", "ios", "android", "kotlin android", "flutter", "react native",
  "sql", "nosql", "etl", "apache spark", "hadoop", "airflow", "dbt",
  "figma", "adobe xd", "ui/ux", "ux design",
  "agile", "scrum", "jira", "confluence",
  "oauth", "jwt", "oauth2", "sso", "ldap", "active directory",
  "linux", "unix", "bash", "shell scripting", "powershell",
  "blockchain", "solidity", "web3", "ethereum",
  "selenium", "cypress", "jest", "mocha", "pytest", "junit", "testing",
  "webpack", "vite", "babel", "eslint", "prettier",
  "nginx", "apache http", "iis",
  "opencv", "opencv.js",
  "excel", "vba",
];

const ROLE_PHRASES = [
  "full stack developer", "full-stack developer", "fullstack developer",
  "frontend developer", "front-end developer", "front end developer", "ui developer", "react developer",
  "backend developer", "back-end developer", "back end developer", "api developer",
  "software engineer", "software developer", "sde", "swe",
  "devops engineer", "site reliability engineer", "sre", "cloud engineer",
  "data engineer", "data analyst", "data scientist", "ml engineer", "machine learning engineer",
  "product manager", "project manager", "business analyst", "qa engineer", "test engineer",
  "mobile developer", "ios developer", "android developer", "security engineer", "cybersecurity",
];

const DOMAIN_KEYWORDS = [
  { domain: "Fintech", patterns: [/fintech/, /\bbanking\b/, /\bfinance\b/, /payments?/, /wallet/] },
  { domain: "Healthcare", patterns: [/health\s*care/, /medical/, /clinical/, /pharma/, /hipaa/] },
  { domain: "E-commerce", patterns: [/e-?commerce/, /ecommerce/, /retail/, /marketplace/] },
  { domain: "EdTech", patterns: [/edtech/, /education\s+tech/, /e-?learning/, /lms/] },
  { domain: "SaaS", patterns: [/\bsaas\b/, /subscription\s+platform/, /b2b\s+software/] },
  { domain: "Gaming", patterns: [/gaming/, /game\s+development/, /unity/, /unreal\s+engine/] },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const extractionCache = new Map();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashString(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 20);
}

export function cleanResumeText(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s+#.\-]/g, " ")
    .trim();
}

function isLikelyResumeTextBlob(resumeField) {
  if (!resumeField || typeof resumeField !== "string") return false;
  const t = resumeField.trim();
  if (t.length < 40) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

export function buildResumeCompositeText(candidate) {
  const parts = [];
  if (candidate.professionalSummary) parts.push(String(candidate.professionalSummary));
  if (Array.isArray(candidate.skills)) parts.push(candidate.skills.join(" "));
  if (candidate.yearsOfExperience != null && candidate.yearsOfExperience !== "")
    parts.push(`${candidate.yearsOfExperience} years experience`);
  if (isLikelyResumeTextBlob(candidate.resume)) parts.push(candidate.resume);
  else if (candidate.resume && /^https?:\/\//i.test(String(candidate.resume).trim())) {
    parts.push("Experienced professional; resume on file.");
  }
  return parts.join("\n\n");
}

/** After JD aggregate + $lookup, `populate('offerId')` sometimes leaves ref unset; use embedded `offerObj`. */
export function normalizeJdOfferForRanking(jd) {
  const o = jd.offerId;
  if (o && typeof o === "object" && (o._id != null || o.jobTitle != null || (Array.isArray(o.skills) && o.skills.length > 0))) {
    return { ...jd, offerId: o };
  }
  if (jd.offerObj && typeof jd.offerObj === "object") {
    return { ...jd, offerId: jd.offerObj };
  }
  return jd;
}

export function extractSkills(resumeText) {
  const cleaned = cleanResumeText(resumeText);
  if (!cleaned) return [];
  const found = [];
  const sorted = [...PREDEFINED_SKILLS].sort((a, b) => b.length - a.length);
  for (const skill of sorted) {
    const s = skill.toLowerCase();
    if (s.length <= 2) continue;
    const pattern =
      s.length <= 3 || /\W/.test(s)
        ? new RegExp(escapeRegex(s), "i")
        : new RegExp(`\\b${escapeRegex(s)}\\b`, "i");
    if (pattern.test(cleaned) && !found.some((f) => f.toLowerCase() === s)) {
      found.push(skill);
    }
  }
  return found;
}

export function extractExperienceYears(resumeText) {
  if (!resumeText) return null;
  const s = String(resumeText).toLowerCase();
  const nums = [];
  const re =
    /(\d+(?:\.\d+)?)\s*\+?\s*(?:y(?:ears?|rs?|oe)?|years?\s+of\s+experience|yoe)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    if (!Number.isNaN(n) && n >= 0 && n <= 45) nums.push(n);
  }
  const range = s.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*years?/i);
  if (range) {
    const hi = parseFloat(range[2]);
    if (!Number.isNaN(hi) && hi <= 45) nums.push(hi);
  }
  if (nums.length === 0) return null;
  return Math.min(45, Math.max(...nums));
}

export function extractRoles(resumeText) {
  const t = String(resumeText || "").toLowerCase();
  const roles = [];
  for (const phrase of ROLE_PHRASES) {
    if (t.includes(phrase)) roles.push(phrase.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return [...new Set(roles)];
}

export function extractProjects(resumeText) {
  const lines = String(resumeText || "").split(/\r?\n/);
  const projects = [];
  const projRe = /(project|portfolio|built|developed|implemented|designed)\s*[:\-]?\s*(.{8,120})/i;
  for (const line of lines) {
    const m = line.match(projRe);
    if (m) projects.push(m[2].trim());
  }
  return [...new Set(projects)].slice(0, 8);
}

export function extractTechnologies(resumeText) {
  const skills = extractSkills(resumeText);
  return skills.filter((s) =>
    /js|python|java|sql|aws|azure|docker|react|node|api|cloud|kubernetes|kubernetes|git/i.test(s)
  );
}

export function extractDomains(resumeText) {
  const t = String(resumeText || "").toLowerCase();
  const out = [];
  for (const { domain, patterns } of DOMAIN_KEYWORDS) {
    if (patterns.some((p) => p.test(t))) out.push(domain);
  }
  return [...new Set(out)];
}

function normalizeSkillToken(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mergeUniqueSkills(fromResume, fromDb) {
  const map = new Map();
  for (const s of [...fromResume, ...fromDb]) {
    const k = normalizeSkillToken(s);
    if (k.length < 2) continue;
    if (!map.has(k)) map.set(k, s.trim());
  }
  return [...map.values()];
}

function jobRequiredSkillList(jd, offer) {
  const req = new Map();
  const add = (arr) => {
    for (const x of arr || []) {
      const k = normalizeSkillToken(x);
      if (k.length >= 2) req.set(k, String(x).trim());
    }
  };
  add(offer?.skills);
  if (req.size === 0 && Array.isArray(jd.requirements)) {
    for (const line of jd.requirements) {
      for (const part of String(line).split(/[,;|]/)) {
        const k = normalizeSkillToken(part);
        if (k.length >= 3) req.set(k, part.trim());
      }
    }
  }
  return [...req.entries()].map(([, v]) => v);
}

function skillMatchSets(candidateSkillsList, requiredList) {
  const requiredNorm = requiredList.map(normalizeSkillToken).filter(Boolean);
  const candSet = new Set((candidateSkillsList || []).map(normalizeSkillToken).filter(Boolean));
  const matched = [];
  const missing = [];
  for (let i = 0; i < requiredList.length; i++) {
    const rn = requiredNorm[i];
    let hit = candSet.has(rn);
    if (!hit) {
      for (const c of candSet) {
        if (c.includes(rn) || rn.includes(c)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.push(requiredList[i]);
    else missing.push(requiredList[i]);
  }
  const denom = requiredNorm.length || 1;
  const skillScore = Math.min(1, matched.length / denom);
  return { matched, missing, skillScore };
}

function experienceScore01(candidateYears, offerExpStr) {
  if (candidateYears == null || Number.isNaN(Number(candidateYears))) return 0.5;
  const y = Number(candidateYears);
  const { min } = parseJobExperienceRange(offerExpStr || "");
  if (min <= 0) return 1;
  if (y >= min) return 1;
  return Math.max(0, Math.min(1, y / min));
}

function tokenizeForTfidf(text) {
  const raw = String(text || "").toLowerCase().replace(/[^\w\s+#.]/g, " ");
  const tokens = tokenizer.tokenize(raw) || raw.split(/\s+/);
  const sw = natural.stopwords || natural.default?.stopwords || [];
  const stop = new Set([...sw, ...EXTRA_STOP]);
  const out = [];
  for (const w of tokens) {
    if (!w || w.length < 2 || stop.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function tfIdfCosineSimilarity(docA, docB) {
  const a = tokenizeForTfidf(docA);
  const b = tokenizeForTfidf(docB);
  if (!a.length || !b.length) return 0;
  const vocab = [...new Set([...a, ...b])];
  const N = 2;
  const idf = {};
  for (const term of vocab) {
    let df = 0;
    if (a.includes(term)) df++;
    if (b.includes(term)) df++;
    idf[term] = Math.log((N + 1) / (df + 1)) + 1;
  }
  const tf = (tokens) => {
    const m = {};
    for (const t of tokens) m[t] = (m[t] || 0) + 1;
    return m;
  };
  const tfa = tf(a);
  const tfb = tf(b);
  const maxA = Math.max(...Object.values(tfa), 1);
  const maxB = Math.max(...Object.values(tfb), 1);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const term of vocab) {
    const v1 = ((tfa[term] || 0) / maxA) * idf[term];
    const v2 = ((tfb[term] || 0) / maxB) * idf[term];
    dot += v1 * v2;
    na += v1 * v1;
    nb += v2 * v2;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

function buildJobTextBlob(jd, offer) {
  return [
    offer?.jobTitle,
    offer?.description,
    ...(offer?.skills || []),
    ...(offer?.preferredSkills || []),
    offer?.experience,
    jd.jobSummary,
    jd.keyResponsibilities,
    jd.requiredQualifications,
    jd.additionalInfo,
    jd.additionalNotes,
    ...(jd.responsibilities || []),
    ...(jd.requirements || []),
    ...(jd.benefits || []),
  ]
    .filter(Boolean)
    .join("\n");
}

export function extractResumeProfile(resumeText, candidate) {
  const text = resumeText || buildResumeCompositeText(candidate);
  const fromDb = Array.isArray(candidate.skills) ? candidate.skills : [];
  const fromResume = extractSkills(text);
  const skills = mergeUniqueSkills(fromResume, fromDb);
  const extractedYears = extractExperienceYears(text);
  const dbYears = candidate.yearsOfExperience;
  const experienceYears =
    dbYears != null && !Number.isNaN(Number(dbYears))
      ? Math.max(Number(dbYears), extractedYears ?? 0)
      : extractedYears;

  return {
    skills,
    experienceYears: experienceYears ?? null,
    roles: extractRoles(text),
    projects: extractProjects(text),
    technologies: extractTechnologies(text),
    domains: extractDomains(text),
    textForSimilarity: text,
  };
}

export function getCachedOrExtractProfile(candidate) {
  const composite = buildResumeCompositeText(candidate);
  const key = `${candidate._id}_${hashString(composite)}`;
  const now = Date.now();
  const hit = extractionCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.profile;

  const profile = extractResumeProfile(composite, candidate);
  extractionCache.set(key, { at: now, profile });
  if (extractionCache.size > CACHE_MAX) {
    const first = extractionCache.keys().next().value;
    extractionCache.delete(first);
  }
  return profile;
}

export function calculateMatchScore(profile, jd, offer) {
  const jobBlob = buildJobTextBlob(jd, offer);
  const resumeBlob = [
    (profile.skills || []).join(" "),
    (profile.roles || []).join(" "),
    (profile.projects || []).join(" "),
    (profile.domains || []).join(" "),
    (profile.technologies || []).join(" "),
  ].join("\n");

  const requiredList = jobRequiredSkillList(jd, offer);
  let matched;
  let missing;
  let skillScore;
  if (requiredList.length === 0) {
    const cand = profile.skills || [];
    const lowerBlob = jobBlob.toLowerCase();
    matched = cand.filter((s) => lowerBlob.includes(normalizeSkillToken(s)));
    skillScore =
      cand.length > 0 ? Math.min(1, matched.length / Math.min(cand.length, 12)) : 0.35;
    missing = [];
  } else {
    ({ matched, missing, skillScore } = skillMatchSets(profile.skills, requiredList));
  }

  const exp01 = experienceScore01(profile.experienceYears, offer?.experience);
  const { min } = parseJobExperienceRange(offer?.experience || "");
  const experienceMatch =
    profile.experienceYears != null && !Number.isNaN(Number(profile.experienceYears))
      ? Number(profile.experienceYears) >= min
      : exp01 >= 1;

  const fullResumeSide = [profile.textForSimilarity || "", resumeBlob].filter(Boolean).join("\n\n");
  const similarity01 = tfIdfCosineSimilarity(fullResumeSide, jobBlob);

  const match01 = 0.5 * skillScore + 0.3 * exp01 + 0.2 * similarity01;
  const matchPercentage = Math.round(Math.min(100, Math.max(0, match01 * 100)));

  const reasons = [];
  if (skillScore >= 0.5) reasons.push("Strong overlap with required skills");
  else if (skillScore >= 0.25) reasons.push("Partial skill alignment");
  if (exp01 >= 1) reasons.push("Meets experience expectations");
  else if (exp01 >= 0.7) reasons.push("Close to required experience");
  if (similarity01 >= 0.15) reasons.push("Resume narrative fits the role");

  const reason = reasons.length ? reasons.slice(0, 2).join("; ") : "General fit based on profile and JD text";

  return {
    matchPercentage,
    skillScore,
    experienceScore: exp01,
    similarityScore: similarity01,
    matchedSkills: matched,
    missingSkills: missing,
    experienceMatch
  };
}

/**
 * @param {object} profile from getCachedOrExtractProfile
 * @param {object[]} jds populated JD docs
 * @param {object} opts { minMatchPreferred, minMatchFloor, limit }
 * If any job scores ≥ minMatchPreferred, only those are returned (up to limit).
 * Otherwise returns best jobs above minMatchFloor (default 0) so the UI is never empty when JDs exist.
 */
export function rankJobsForCandidate(profile, jds, opts = {}) {
  const preferred = opts.minMatchPreferred ?? 50;
  const floor = opts.minMatchFloor ?? 0;
  const limit = opts.limit ?? 8;
  const scored = [];
  for (const jd of jds) {
    const jdN = normalizeJdOfferForRanking(jd);
    const offer = jdN.offerId;
    if (!offer) continue;
    const rec = calculateMatchScore(profile, jdN, offer);
    if (rec.matchPercentage < floor) continue;
    scored.push({ jd: jdN, rec });
  }
  scored.sort((a, b) => b.rec.matchPercentage - a.rec.matchPercentage);
  const above = scored.filter((x) => x.rec.matchPercentage >= preferred);
  const pool = above.length > 0 ? above : scored;
  return pool.slice(0, limit);
}

/** Same shape as frontend AllJDs mapping + optional recommendation fields. */
export function mapJdToFrontendCard(jd, rec = null) {
  const offer = jd.offerId || {};
  const card = {
    id: jd._id,
    _id: jd._id,
    title: offer.jobTitle || "Job Title Not Available",
    location: offer.location || jd.location,
    company: jd.companyName || offer.companyName || "Company Not Specified",
    description: offer.description || "Description Not Available",
    companyId: `#${String(jd._id).slice(-6)}`,
    skills:
      jd.requirements?.slice(0, 4).join(", ") + (jd.requirements?.length > 4 ? ", etc." : "") ||
      "Skills not specified",
    skillsArray: jd.requirements?.slice(0, 6) || [],
    primaryLocation: offer.location || "Location Not Specified",
    jobSummary: jd.jobSummary || "",
    responsibilities: jd.responsibilities || [],
    requirements: jd.requirements || [],
    benefits: jd.benefits || [],
    additionalInfo: jd.additionalInfo || "",
    department: jd.department || "",
    createdBy: jd.createdBy || {},
    publicToken: jd.publicToken || "",
    createdAt: jd.createdAt || "",
    offerId: offer,
    appliedCandidates: jd.appliedCandidates,
    dueDate: jd.dueDate,
    salary: jd.salary,
  };
  if (rec) {
    card.matchPercentage = rec.matchPercentage;
    card.matchReason = rec.reason;
    card.matchedSkills = rec.matchedSkills;
    card.missingSkills = rec.missingSkills;
    card.experienceMatch = rec.experienceMatch;
  }
  return card;
}
