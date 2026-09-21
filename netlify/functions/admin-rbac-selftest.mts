import type { Config, Context } from '@netlify/functions';
import { admin } from '@netlify/identity';

function clean(value: unknown, max=500) {
  return String(value || '').trim().slice(0,max);
}
async function call(origin:string,path:string,token:string,init:RequestInit={}) {
  const response=await fetch(origin+path,{
    ...init,
    headers:{
      ...(init.headers||{}),
      Authorization:'Bearer '+token,
      'Content-Type':'application/json',
    },
  });
  return {path,status:response.status,ok:response.ok,body:clean(await response.text().catch(()=>''),500)};
}
export default async (req:Request,_context:Context) => {
  const expected=clean(Netlify.env.get('RBAC_SELFTEST_TOKEN'),200);
  const supplied=clean(new URL(req.url).searchParams.get('token'),200);
  if(!expected || supplied!==expected) return new Response('Not found',{status:404});

  const origin=new URL(req.url).origin;
  const email='rbac-test-'+Date.now()+'@example.com';
  const password='Koa!Rbac'+crypto.randomUUID().replaceAll('-','').slice(0,16)+'9a';
  let created:any=null;
  try {
    created=await admin.createUser({
      email,
      password,
      data:{
        role:'sales',
        app_metadata:{roles:['sales'],active:true},
        user_metadata:{full_name:'RBAC Sales Test'},
      },
    });

    const form=new URLSearchParams({grant_type:'password',username:email,password});
    const login=await fetch(origin+'/.netlify/identity/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:form.toString(),
    });
    const loginData:any=await login.json().catch(()=>({}));
    const accessToken=clean(loginData?.access_token,5000);
    if(!login.ok||!accessToken) {
      return Response.json({ok:false,stage:'login',status:login.status,body:loginData});
    }

    const allowed=await Promise.all([
      call(origin,'/api/admin/crm',accessToken),
      call(origin,'/api/admin/quotes',accessToken),
      call(origin,'/api/admin/events',accessToken),
      call(origin,'/api/admin/calendar',accessToken),
      call(origin,'/api/blog?admin=1',accessToken),
    ]);

    const managerBlocked=await Promise.all([
      call(origin,'/api/admin/crm',accessToken,{method:'POST',body:JSON.stringify({action:'save-workflow'})}),
      call(origin,'/api/admin/quotes',accessToken,{method:'POST',body:JSON.stringify({action:'update-profit-model'})}),
      call(origin,'/api/admin/events',accessToken,{method:'POST',body:JSON.stringify({action:'save-overview'})}),
      call(origin,'/api/blog',accessToken,{method:'POST',body:JSON.stringify({action:'save',title:'RBAC Test',slug:'rbac-test-do-not-save',status:'published'})}),
    ]);

    const adminBlocked=await Promise.all([
      call(origin,'/api/admin/quickbooks',accessToken),
      call(origin,'/api/admin/security',accessToken),
      call(origin,'/api/admin/local-seo',accessToken),
      call(origin,'/api/admin/staff',accessToken),
    ]);

    const allowedPass=allowed.every((row)=>row.status===200);
    const managerPass=managerBlocked.every((row)=>row.status===403);
    const adminPass=adminBlocked.every((row)=>row.status===401||row.status===403);

    return Response.json({
      ok:allowedPass&&managerPass&&adminPass,
      role:'sales',
      allowed,
      managerBlocked,
      adminBlocked,
      summary:{allowedPass,managerPass,adminPass},
    },{headers:{'Cache-Control':'no-store'}});
  } finally {
    if(created?.id) await admin.deleteUser(created.id).catch(()=>{});
  }
};

export const config: Config={path:'/api/admin/rbac-selftest'};
