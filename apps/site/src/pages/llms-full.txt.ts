// llms-full.txt: every docs page in one file, from the docs repo.
import type { APIRoute } from "astro";
import { llmsFile, textResponse } from "../lib/llms";

export const GET: APIRoute = () => textResponse(llmsFile("llms-full.txt"));
