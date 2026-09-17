// Registry of Wordle-playing profiles. To add one, create a file in this folder and list it here.
import knockout from './knockout.mjs';
import letterByLetter from './letter-by-letter.mjs';
import parallelLetters from './parallel-letters.mjs';

export const PROFILES = [knockout, letterByLetter, parallelLetters];
export const DEFAULT_PROFILE = knockout.name;

export function getProfile(name = DEFAULT_PROFILE) {
  const profile = PROFILES.find(p => p.name === name);
  if (!profile) throw new Error(`Unknown profile "${name}". Available: ${PROFILES.map(p => p.name).join(', ')}`);
  return profile;
}
