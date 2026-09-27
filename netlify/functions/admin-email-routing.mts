import type { Config } from '@netlify/functions';
import { requireCapability } from './_shared/admin';
import { emailRoutingSummary, saveEmailRouting } from './_shared/email-routing';

export default async (req:Request) => {
  if (req.method === 'GET') {
    const auth=await requireCapability('email.view',req);
    if(auth.response)return auth.response;
    return Response.json(await emailRoutingSummary(),{headers:{'Cache-Control':'private, no-store'}});
  }
  if (req.method === 'PUT') {
    const auth=await requireCapability('email.manage',req);
    if(auth.response)return auth.response;
    try{
      const body=await req.json().catch(()=>({}));
      return Response.json(await saveEmailRouting(body,auth.user?.email||'staff'),{headers:{'Cache-Control':'private, no-store'}});
    }catch(error){
      return Response.json({error:error instanceof Error?error.message:'Unable to save email routing.'},{status:400});
    }
  }
  return new Response('Method Not Allowed',{status:405,headers:{Allow:'GET, PUT'}});
};
export const config:Config={path:'/api/admin/email-routing'};
