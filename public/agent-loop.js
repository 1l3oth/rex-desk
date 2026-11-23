// A loop is on but has nowhere to look: no task source chosen, or only trackers that were removed since. It would find nothing.
export const loopFindsNothing = (loop, taskSources = [], sourceIds = []) => Boolean(loop?.on) && !(taskSources || []).some(id => id === 'local' || sourceIds.includes(id));
