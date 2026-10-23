/** Browser keys shared by the home screen, module screen and today's loop. */

/** The module the home screen remembers as last opened; it decides where new questions come from. */
export const LAST_MODULE_KEY = 'loopdeck3.library.last-module';

/** Set before opening a module from the resume banner; the module screen resumes once and clears it. */
export const AUTO_RESUME_KEY = 'loopdeck3.library.autoresume';

/** Monday (YYYY-MM-DD) of the last week whose recap the home screen already offered. */
export const WEEKLY_SEEN_KEY = 'loopdeck3.weekly.seen';

/** Session storage id of today's loop, which mixes questions from several modules. */
export const TODAY_MODULE_ID = 'today';
