import type { ProjectFiles } from './api';

/** Lists `dir`, or nothing when it does not exist: the IDE's native listing rejects missing folders
 *  (var/cache, src/Entity, mapping dirs are optional in a Symfony project). */
export async function listIn(files: ProjectFiles, dir: string, accept: (name: string) => boolean): Promise<string[]> {
 try { return await files.list(dir, accept); } catch { return []; }
}
