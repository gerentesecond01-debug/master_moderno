// NEXUS GROUP INVITER - sem senha manual e sem URL do Agent.
// Cada prim gera uma chave automaticamente e requer aprovação no Master.
string MASTER = "https://mastereagente.onrender.com";
string CHAVE = "";
integer PRONTO = FALSE;
integer REGISTRANDO = FALSE;
key requisicao;
list avatares = [];
list horarios = [];

registrar()
{
    if (CHAVE == "") CHAVE = (string)llGenerateKey() + (string)llGenerateKey();
    string corpo = llList2Json(JSON_OBJECT, [
        "primId", (string)llGetKey(),
        "ownerId", (string)llGetOwner(),
        "token", CHAVE
    ]);
    REGISTRANDO = TRUE;
    requisicao = llHTTPRequest(MASTER + "/api/prim-invites/enroll",
        [HTTP_METHOD, "POST", HTTP_MIMETYPE, "application/json"], corpo);
}

default
{
    state_entry()
    {
        llSetText("CLIQUE PARA ENTRAR NO GRUPO", <0.1, 1.0, 0.4>, 1.0);
        registrar();
    }
    on_rez(integer n) { llResetScript(); }
    changed(integer change)
    {
        if (change & (CHANGED_OWNER | CHANGED_INVENTORY)) llResetScript();
    }
    touch_start(integer total)
    {
        integer i;
        for (i=0; i<total; ++i)
        {
            key avatar=llDetectedKey(i);
            if (!(llDetectedType(i) & AGENT)) jump proximo;
            integer agora=llGetUnixTime();
            integer pos=llListFindList(avatares, [(string)avatar]);
            if (pos != -1)
            {
                if (agora - llList2Integer(horarios,pos) < 60)
                {
                    llRegionSayTo(avatar,0,"Aguarde um minuto antes de solicitar outro convite.");
                    jump proximo;
                }
                horarios=llListReplaceList(horarios,[agora],pos,pos);
            }
            else
            {
                avatares += [(string)avatar];
                horarios += [agora];
            }
            string corpo=llList2Json(JSON_OBJECT,["primId",(string)llGetKey(),"avatarId",(string)avatar]);
            llHTTPRequest(MASTER + "/api/prim-invites/click",
                [HTTP_METHOD,"POST",HTTP_MIMETYPE,"application/json",
                 HTTP_CUSTOM_HEADER,"X-Nexus-Prim-Key",CHAVE], corpo);
            llRegionSayTo(avatar,0,"Solicitando convite para o grupo...");
@proximo;
        }
    }
    http_response(key id, integer status, list metadata, string body)
    {
        if (id == requisicao)
        {
            REGISTRANDO = FALSE;
            if (status >= 200 && status < 300) llOwnerSay("NEXUS: prim cadastrado. Aprove em /prim-convites.html no Master.");
            else llOwnerSay("NEXUS: falha ao registrar prim (HTTP " + (string)status + ").");
            return;
        }
        if (status < 200 || status >= 300)
            llOwnerSay("NEXUS: convite não solicitado. HTTP " + (string)status + " - " + llGetSubString(body,0,180));
    }
}
