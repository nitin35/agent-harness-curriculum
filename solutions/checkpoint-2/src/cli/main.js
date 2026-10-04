#!/usr/bin/env node
// src/cli/main.js — Day 15: the first interactive entry point. Day 26 adds flags, settings and modes.
import { createApp } from '../app.js';

const app = createApp({ streaming: process.env.AH_STREAM !== '0' });
app.start();
