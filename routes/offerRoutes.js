import express from "express";
import {protect} from "../middlewares/auth.js";
import { authorize } from '../middlewares/roles.js';
import {createOffer, getAllHr, getRmgOffersWithJDs, getAllOffers, assignOfferToHr, updateOffer, deleteOffer, getLatestFilteredUnfilteredCandidates, getAllFilteredUnfilteredCandidates, suggestSkills, updateRmgProfile } from "../controllers/offerController.js";

const router = express.Router();

router.post("/suggest-skills", protect, authorize("RMG"), suggestSkills);
router.post("/", protect, authorize("RMG"), createOffer);
router.get("/hr", protect, authorize("RMG"), getAllHr);
router.get("/overview", protect, authorize("RMG"), getRmgOffersWithJDs);
router.get("/all-offers", protect, authorize("RMG", "Admin"), getAllOffers);
router.post("/assign", protect, authorize("RMG"), assignOfferToHr);
router.put("/:id/offer-update", protect, authorize("RMG"), updateOffer);
router.delete("/:id", protect, authorize("RMG"), deleteOffer);
router.get('/latest-candidates', protect, authorize('RMG','HR'), getLatestFilteredUnfilteredCandidates);
router.get('/all-candidates-filtered', protect, authorize('RMG','HR'), getAllFilteredUnfilteredCandidates);
router.put('/rmg/:id', protect, authorize('RMG'), updateRmgProfile);

export default router;