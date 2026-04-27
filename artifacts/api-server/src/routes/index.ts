import { Router, type IRouter } from "express";
import healthRouter from "./health";
import articlesRouter from "./articles";

const router: IRouter = Router();

router.use(healthRouter);
router.use(articlesRouter);

export default router;
