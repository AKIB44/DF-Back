'use strict';

// Google Calendar integration for the Marketing module (PRD_V2 §12).
//
// Productionization (deferred — PRD §14 Q2/Q3): each assigned user connects their
// Google account via OAuth2; tokens are stored encrypted and used to create/
// update/delete events with a Hangouts Meet conference. Until that is wired up,
// this service runs in STUB mode: it synthesizes an event id + Meet link so the
// end-to-end booking → scheduled-calls flow works, and reports sync_status so the
// UI can show "pending sync". Flip GOOGLE_CALENDAR_ENABLED=true once OAuth exists
// and replace the throw with real googleapis calls.

const crypto = require('crypto');

const ENABLED = process.env.GOOGLE_CALENDAR_ENABLED === 'true';

function isEnabled() {
  return ENABLED;
}

function stubEvent() {
  const id = 'stub_' + crypto.randomBytes(8).toString('hex');
  return {
    eventId:  id,
    meetLink: `https://meet.google.com/lookup/${id}`,
    synced:   false,           // stub — not actually on a Google calendar
  };
}

/**
 * Create a calendar event for a scheduled call.
 * @returns {{ eventId: string, meetLink: string|null, synced: boolean }}
 */
async function createEvent(/* { summary, description, start, end, attendees, organizerUserId } */) {
  if (!ENABLED) return stubEvent();
  // TODO: real Google Calendar API call with the organizer's OAuth token.
  // const cal = google.calendar({ version: 'v3', auth });
  // const res = await cal.events.insert({ calendarId: 'primary', conferenceDataVersion: 1, requestBody: {...} });
  // return { eventId: res.data.id, meetLink: res.data.hangoutLink, synced: true };
  throw new Error('Google Calendar integration not configured');
}

async function updateEvent(/* eventId, patch */) {
  if (!ENABLED) return { synced: false };
  throw new Error('Google Calendar integration not configured');
}

async function deleteEvent(/* eventId */) {
  if (!ENABLED) return { synced: false };
  throw new Error('Google Calendar integration not configured');
}

module.exports = { isEnabled, createEvent, updateEvent, deleteEvent };
