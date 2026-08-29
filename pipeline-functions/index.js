'use strict';
/**
 * pipeline-functions — Maxela backend pipeline codebase.
 *
 * Separate Firebase Functions codebase from `tuya-functions/` (reserved for Tuya
 * smart-lock integration — see tuya-functions/README.md). Deployed via
 * firebase.json's second `functions[]` entry, codebase id "pipeline".
 *
 * See README.md for the pipe map, testing instructions, and deploy commands.
 *
 * Phase 1 (live): elevatorCodeGuard, elevatorCodeSync.
 * Phase 2 (this branch): adminAction callable → RoomAssignment (move/swap/release).
 */

const { initializeApp, getApps } = require('firebase-admin/app');
if (!getApps().length) initializeApp();

const { registerCloudFunction: registerElevatorCodeGuard } = require('./controllers/elevatorCodeGuard');
const { registerCloudFunctions: registerElevatorCodeSync } = require('./controllers/elevatorCodeSync');
const { registerCloudFunction: registerAdminAction } = require('./controllers/adminAction');

exports.elevatorCodeGuard = registerElevatorCodeGuard();

const { elevatorCodeSync, elevatorCodeSyncManual } = registerElevatorCodeSync();
exports.elevatorCodeSync = elevatorCodeSync;
exports.elevatorCodeSyncManual = elevatorCodeSyncManual;

exports.adminAction = registerAdminAction();
