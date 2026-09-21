import type { Config, Context } from '@netlify/functions';
import {
  buildPublicStatus,
  calculateIncidents,
  calculateUptime,
  readHealthAlertPolicy,
  readLatestHealth,
  readUptimeHistory,
} from './_shared/system-health';

export default async (_req:Request,context:Context) => {
  const [latest,history,policy]=await Promise.all([
    readLatestHealth(context),
    readUptimeHistory(context,2300),
    readHealthAlertPolicy(context),
  ]);
  const uptime=calculateUptime(history);
  const incidents=calculateIncidents(history);
  const status=buildPublicStatus(latest,incidents,uptime,policy);
  return Response.json(status,{headers:{'Cache-Control':'public, max-age=60, s-maxage=60'}});
};

export const config:Config={path:'/api/status'};
