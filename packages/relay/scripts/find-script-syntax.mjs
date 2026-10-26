import { readFileSync } from "node:fs";

const html = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : await (await fetch("https://my.parthaunnava.com/")).text();

const start = html.indexOf("<script>\n");
const end = html.lastIndexOf("</script>");
const script = html.slice(start + "<script>\n".length, end);
try {
  new Function(script);
  console.log("syntax: ok", script.length, "chars");
} catch (e) {
  console.log("syntax:", e.message);
  const m = /position (\d+)/.exec(String(e)) || /:(\d+)/.exec(e.stack || "");
  const pos = m ? Number(m[1]) : null;
  if (pos != null && !Number.isNaN(pos)) {
    const line = script.slice(0, pos).split("\n").length;
    const lines = script.split("\n");
    console.log("near line", line);
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i++) {
      console.log(String(i + 1).padStart(5), lines[i]);
    }
  }
}
