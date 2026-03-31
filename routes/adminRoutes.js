// routes/adminRoutes.js
import express from 'express';
import { registerRMG, registerHR, updateAdmin } from '../controllers/adminController.js';
import { getAllRMG } from '../controllers/adminController.js';
import { updateRmg } from '../controllers/adminController.js';
import { deleteRmg,getAllHR,getRecruiterById,deleteHR,updateHR,getAllHrAccordingtoComapny  } from '../controllers/adminController.js';
import { protect } from '../middlewares/auth.js';
import { authorize } from '../middlewares/roles.js';

const router = express.Router();

// All routes below are protected and only accessible by Admins
router.use(protect);
router.use(authorize('Admin'));

// POST /api/admin/rmg
router.post('/rmg', registerRMG);

// POST /api/admin/hr
router.post('/hr', registerHR);
router.get('/allrmg', protect, getAllRMG);
router.get('/allhr', protect, getAllHR);
router.get('/getallhr',protect, getAllHrAccordingtoComapny )
router.get('/recruiter/:id', protect, getRecruiterById);
router.put('/rmg/:id', protect, updateRmg);
router.put('/admin/:id', protect, updateAdmin);
router.put('/hr/:id', protect, updateHR);
router.delete('/rmg/:id', protect, deleteRmg);
router.delete('/hr/:id', protect, deleteHR);


export default router;
