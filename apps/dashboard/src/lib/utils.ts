import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class name helper for the ai-elements and shadcn components (src/components/ai-elements, src/components/ui). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
