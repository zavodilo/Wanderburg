// run.mjs — thin forwarder: the cross-platform entry is tools/arc.mjs (any OS).
import { dispatch } from './arc.mjs';
process.exit(dispatch(['run', ...process.argv.slice(2)]));
