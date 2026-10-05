// llms-full.txt: every docs page in one file, from the docs repo, with a status sentence on top and a Videos section
// at the end.
import type { APIRoute } from "astro";
import { llmsFile, textResponse, videosSection, withStatus } from "../lib/llms";

export const GET: APIRoute = () => {
  const text = withStatus(llmsFile("llms-full.txt"));
  return textResponse(`${text.trimEnd()}\n\n${videosSection("## Videos")}`);
};
