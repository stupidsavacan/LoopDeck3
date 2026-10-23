import { env } from 'cloudflare:workers';
import { syncApi } from '../../../../lib/sync-api';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => syncApi(request, env);
export const POST = GET;
export const OPTIONS = GET;
