// The one place that decides where the GUI's data comes from. Until the connection layer of
// Issue #3 exists this is the mock; a live implementation of RuntimeApi replaces it here.
import { createMockApi } from './mock';
import type { RuntimeApi } from './types';

export const api: RuntimeApi = createMockApi();
