// /llms/<section>.txt: the full text of one docs section, from the docs repo.
import type { APIRoute } from "astro";
import { llmsFile, llmsShards, textResponse } from "../../lib/llms";

export const getStaticPaths = () => llmsShards().map((name) => ({ params: { name } }));

export const GET: APIRoute = ({ params }) => textResponse(llmsFile(`llms/${params.name}.txt`));
