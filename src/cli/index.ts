#!/usr/bin/env node
import { createProgram } from "./program.js";
import { CcpError } from "../core/errors.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof CcpError) {
    console.error(`ccp: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
