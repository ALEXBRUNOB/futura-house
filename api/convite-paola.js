export default async function handler(req,res){
  if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({ok:false});}
  const resposta=req.body&&req.body.resposta;
  if(!["sim","conversar"].includes(resposta)) return res.status(400).json({ok:false});
  console.log(JSON.stringify({event:"convite_paola_maia",resposta,data:new Date().toISOString()}));
  return res.status(204).end();
}