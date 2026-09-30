// The Markdown twin of every blog post: /blog/<slug>.md.
import type { APIRoute } from "astro";
import { blogPosts, type BlogPost } from "../../lib/docs";
import { markdownTwin, markdownResponse } from "../../lib/markdown-twin";

export async function getStaticPaths() {
  return (await blogPosts()).map((post) => ({ params: { slug: post.slug }, props: { post } }));
}

export const GET: APIRoute = ({ props }) => {
  const { post } = props as { post: BlogPost };
  return markdownResponse(markdownTwin(`${post.entry.id}.md`, post.entry.data, post.entry.body ?? "", post.href));
};
