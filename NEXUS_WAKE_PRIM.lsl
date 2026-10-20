// NEXUS WAKE PRIM - Um prim para todos os Agents
// IMPORTANTE: revogue o token GitHub divulgado anteriormente.
string GITHUB_TOKEN = "COLOQUE_TOKEN_NOVO_AQUI";
string GITHUB_OWNER = "gerentesecond01-debug";
string GITHUB_REPO = "prim";
string GITHUB_BRANCH = "main";
string MASTER_SECRET = "MESMO_MASTER_SECRET_DO_RENDER";
string PRIM_ID = "nexus-wake-01";

string MY_URL = "";
string SHA = "";
string AGENT_ID = "";
string AGENT_URL = "";
key URL_REQ = NULL_KEY;
key GET_REQ = NULL_KEY;
key PUT_REQ = NULL_KEY;
key AGENTS_REQ = NULL_KEY;
key WAKE_REQ = NULL_KEY;
integer RETRIES = 0;
integer REGISTERED = FALSE;

string api(integer getMode)
{
    // Mesmo formato do script original fornecido pelo proprietario.
    string result = "https://" + GITHUB_TOKEN + "@api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/prim.json";
    if (getMode) result += "?ref=" + GITHUB_BRANCH;
    return result;
}
string rawAgents()
{
    return "https://raw.githubusercontent.com/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/" + GITHUB_BRANCH + "/agents.json";
}
status(string msg, vector color)
{
    llSetText("NEXUS WAKE PRIM\n" + msg, color, 1.0);
}
requestURL()
{
    REGISTERED = FALSE;
    MY_URL = "";
    status("Solicitando URL...", <1.0,1.0,0.0>);
    URL_REQ = llRequestURL();
}
getSha()
{
    GET_REQ = llHTTPRequest(api(TRUE), [HTTP_METHOD,"GET",HTTP_USER_AGENT,"NEXUS-Prim"], "");
}
putUrl(string sha)
{
    string data = llList2Json(JSON_OBJECT,["prim_id",PRIM_ID,"url",MY_URL,"updated_at",llGetTimestamp(),"status","online"]);
    string payload = llList2Json(JSON_OBJECT,["message","NEXUS atualizar URL do prim","content",llStringToBase64(data),"branch",GITHUB_BRANCH]);
    if (sha != "") payload = llJsonSetValue(payload,["sha"],sha);
    PUT_REQ = llHTTPRequest(api(FALSE),[HTTP_METHOD,"PUT",HTTP_MIMETYPE,"application/json"],payload);
}
integer validAgent(string url)
{
    // O prim so aceita um host exato da plataforma Render e sem caminhos arbitrarios.
    if (llSubStringIndex(url,"https://") != 0) return FALSE;
    string tail = llGetSubString(url,8,-1);
    if (llSubStringIndex(tail,"/") != -1) return FALSE;
    if (llSubStringIndex(tail,"?") != -1) return FALSE;
    if (llSubStringIndex(tail,"#") != -1) return FALSE;
    if (llSubStringIndex(tail,":") != -1) return FALSE;
    if (llStringLength(tail) < 14) return FALSE;
    return llGetSubString(tail,-13,-1) == ".onrender.com";
}
startLookup()
{
    AGENTS_REQ = llHTTPRequest(rawAgents() + "?t=" + (string)llGetUnixTime(),[HTTP_METHOD,"GET",HTTP_USER_AGENT,"NEXUS-Prim"],"");
    if (AGENTS_REQ == NULL_KEY) AGENT_ID = "";
}
default
{
    state_entry()
    {
        RETRIES = 0;
        requestURL();
    }
    on_rez(integer n) { llResetScript(); }
    changed(integer c)
    {
        if (c & CHANGED_REGION) llResetScript();
    }
    touch_start(integer total)
    {
        if (llDetectedKey(0) == llGetOwner()) requestURL();
    }
    timer()
    {
        llSetTimerEvent(0.0);
        if (RETRIES >= 3)
        {
            status("Falha ao registrar URL",<1.0,0.0,0.0>);
            return;
        }
        RETRIES++;
        if (MY_URL == "") requestURL();
        else getSha();
    }
    http_request(key id, string method, string body)
    {
        if (id == URL_REQ)
        {
            if (method == URL_REQUEST_GRANTED)
            {
                MY_URL = body;
                RETRIES = 0;
                getSha();
            }
            else
            {
                status("URL negada",<1.0,0.0,0.0>);
                llSetTimerEvent(60.0);
            }
            return;
        }
        if (method == "GET")
        {
            llHTTPResponse(id,200,"NEXUS_PRIM_ONLINE");
            return;
        }
        if (method == "POST")
        {
            string secret = llJsonGetValue(body,["secret"]);
            string action = llJsonGetValue(body,["action"]);
            string agentId = llJsonGetValue(body,["agent_id"]);
            if (secret != MASTER_SECRET || llStringLength(secret) < 20)
            {
                llHTTPResponse(id,403,"FORBIDDEN");
                return;
            }
            if (action != "wake" || agentId == JSON_INVALID || agentId == "" || (string)((integer)agentId) != agentId)
            {
                llHTTPResponse(id,400,"INVALID_COMMAND");
                return;
            }
            if (AGENT_ID != "")
            {
                llHTTPResponse(id,429,"BUSY");
                return;
            }
            AGENT_ID = agentId;
            startLookup();
            llHTTPResponse(id,202,"LOOKUP_STARTED");
            return;
        }
        llHTTPResponse(id,405,"METHOD_NOT_ALLOWED");
    }
    http_response(key id, integer code, list meta, string body)
    {
        if (id == GET_REQ)
        {
            if (code == 200) putUrl(llJsonGetValue(body,["sha"]));
            else if (code == 404) putUrl("");
            else
            {
                llOwnerSay("NEXUS GitHub GET HTTP " + (string)code);
                llSetTimerEvent(60.0);
            }
            return;
        }
        if (id == PUT_REQ)
        {
            if (code == 200 || code == 201)
            {
                REGISTERED = TRUE;
                RETRIES = 0;
                status("ONLINE - GitHub sincronizado",<0.0,1.0,0.0>);
            }
            else
            {
                llOwnerSay("NEXUS GitHub PUT HTTP " + (string)code);
                llSetTimerEvent(60.0);
            }
            return;
        }
        if (id == AGENTS_REQ)
        {
            if (code != 200)
            {
                llOwnerSay("NEXUS agents.json HTTP " + (string)code);
                AGENT_ID = "";
                return;
            }
            list entries = llJson2List(llJsonGetValue(body,["agents"]));
            integer i;
            string found = "";
            // A lista JSON de objetos e percorrida por indice via llJsonGetValue.
            for (i=0; i<100; ++i)
            {
                string idValue = llJsonGetValue(body,["agents",i,"id"]);
                if (idValue == JSON_INVALID) jump done;
                if (idValue == AGENT_ID && llJsonGetValue(body,["agents",i,"enabled"]) == "true")
                {
                    found = llJsonGetValue(body,["agents",i,"url"]);
                    jump done;
                }
            }
            @done;
            if (validAgent(found))
            {
                AGENT_URL = found;
                WAKE_REQ = llHTTPRequest(found + "/",[HTTP_METHOD,"GET"],"");
                if (WAKE_REQ == NULL_KEY) llOwnerSay("NEXUS: falha ao iniciar ping");
            }
            else llOwnerSay("NEXUS: Agent nao autorizado ou URL invalida: " + AGENT_ID);
            AGENT_ID = "";
            return;
        }
        if (id == WAKE_REQ)
        {
            llOwnerSay("NEXUS: despertar " + AGENT_URL + " respondeu HTTP " + (string)code);
            AGENT_URL = "";
            return;
        }
    }
}
