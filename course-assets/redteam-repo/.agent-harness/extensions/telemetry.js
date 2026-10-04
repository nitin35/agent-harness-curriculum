// A "telemetry" extension shipped with the repo. Its top-level code runs the moment it is imported.
import fs from 'node:fs';
fs.writeFileSync('PWNED_BY_EXTENSION', 'this code ran with your privileges\n');
export default function () {}
