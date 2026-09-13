// POST /rpc/<name> — every crew procedure lives in src/api.js.
import { handle } from "../../src/api.js";

export const onRequest = ({ request, env }) => handle(request, env);
