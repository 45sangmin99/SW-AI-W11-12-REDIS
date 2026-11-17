import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = mkdtempSync(resolve(process.argv[2] || ".", "query-lab-data-"));
const rows = Array.from({ length: 50_000 }, (_, index) => {
  const id = index + 1;
  return `${id},Character ${id},${id * 37 % 251}\n`;
});
writeFileSync(resolve(directory, "characters.schema"), "id INT AUTO\nname VARCHAR(80)\nattack INT\n");
writeFileSync(resolve(directory, "characters.csv"), rows.join(""));
console.log(directory);
