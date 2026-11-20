package com.tarobot.client;

import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Production Android screen transport against a real HubServer: pinned TLS to
 * the Hub's own listener and identity proof, its screen sockets, heartbeat and
 * the Host's own ways of ending a session. Only the target's capture is
 * synthetic (real-hub-peer.mjs); nothing is captured or posted. */
public final class RealHubScreenAudit {
    static final List<JSONObject> events=new ArrayList<>(),delivered=new ArrayList<>();
    static final JSONObject receipt=new JSONObject();
    static BufferedWriter input; static BufferedReader output; static HubTransport transport;
    static void check(boolean value,String name) throws Exception { if(!value) throw new Exception(name); receipt.put(name,true); }
    static JSONObject request(JSONObject value) throws Exception {
        input.write(value+"\n");input.flush();JSONObject reply=new JSONObject(output.readLine());
        if(reply.has("error")) throw new Exception("peer: "+reply.getString("error")); return reply;
    }
    interface Match { boolean test(JSONObject value) throws Exception; }
    /** What the pump has delivered for `id`, waited for up to `seconds`. */
    static JSONObject await(String id,long seconds,Match match) throws Exception {
        long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds);
        synchronized(delivered){while(true){for(JSONObject value:delivered)if(id.equals(value.optString("id"))&&match.test(value))return value;
            long left=end-System.nanoTime();if(left<=0)return null;TimeUnit.NANOSECONDS.timedWait(delivered,left);}}
    }
    /** Acknowledges every JSON delivery and reads then acknowledges every binary one, as the page does. */
    static Thread pump(AtomicBoolean running) {
        Thread thread=new Thread(()->{ try { while(running.get()) {
            JSONObject event; synchronized(events){while(events.isEmpty()&&running.get())events.wait(100);if(events.isEmpty())continue;event=events.remove(0);}
            String id=event.optString("id"),kind=event.optString("kind");JSONObject record=new JSONObject().put("id",id).put("kind",kind);
            try {
                if(kind.equals("screen")){transport.screenAck(id,event.getLong("deliverySequence"));record.put("value",event.getJSONObject("value"));}
                else if(kind.equals("binary")){long n=event.getLong("deliverySequence");int length=event.getInt("byteLength");ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                    while(bytes.size()<length)bytes.write(transport.screenRead(id,n,bytes.size(),262144));transport.screenAck(id,n);record.put("bytes",Base64.getEncoder().encodeToString(bytes.toByteArray()));}
                else if(kind.equals("close"))record.put("reason",event.getString("reason"));
            } catch(Exception error) { record.put("pumpError",String.valueOf(error.getMessage())); }
            synchronized(delivered){delivered.add(record);delivered.notifyAll();}
        } } catch(InterruptedException stopped) { } });
        thread.setDaemon(true);thread.start();return thread;
    }
    static JSONObject type(String id,String type,long seconds) throws Exception { return await(id,seconds,v->v.getString("kind").equals("screen")&&type.equals(v.getJSONObject("value").optString("type"))); }
    static JSONObject closed(String id,long seconds) throws Exception { return await(id,seconds,v->v.getString("kind").equals("close")); }
    /** Opens a fresh Host session on the native transport and waits for its first frame. */
    static String[] view(JSONObject network,String document,String name) throws Exception {
        JSONObject join=request(new JSONObject().put("action","join")).getJSONObject("join"),session=join.getJSONObject("session");
        String sid=session.getString("id"),id=transport.allocate("screen",document);
        try { transport.screenOpen(id,network,join); } catch(Exception error) { JSONObject close=closed(id,2); throw new Exception(name+" open failed: "+error.getMessage()+(close==null?"":" closed "+close.getString("reason")),error); }
        // The peer waits until the Host has both native sockets attached and the target capturing.
        long sequence=request(new JSONObject().put("action","frame").put("id",sid)).getLong("sequence");
        check(type(id,"stream",15)!=null,name+"StreamFromHub");
        JSONObject binary=await(id,15,v->v.getString("kind").equals("binary"));
        check(binary!=null&&!binary.has("pumpError"),name+"FrameFromHub");
        ByteBuffer frame=ByteBuffer.wrap(Base64.getDecoder().decode(binary.getString("bytes"))).order(ByteOrder.LITTLE_ENDIAN);
        check(frame.limit()>32&&frame.get(0)==1&&(frame.getInt(4)&0xffffffffL)==sequence&&frame.getInt(28)==frame.limit()-32,name+"FrameHeaderExact");
        // The Host's readiness round trip: a decoded-frame ack is answered with frame-ready.
        transport.screenSend(id,new JSONObject().put("type","ack").put("sessionId",sid).put("generation",session.getString("generation")).put("frameSequence",sequence));
        check(await(id,10,v->v.getString("kind").equals("screen")&&"frame-ready".equals(v.getJSONObject("value").optString("type"))&&v.getJSONObject("value").getLong("frameSequence")==sequence)!=null,name+"FrameReadyFromHub");
        return new String[]{id,sid};
    }
    static void ended(String id,String sid,String how,String expected,String name) throws Exception {
        request(new JSONObject().put("action","end").put("id",sid).put("how",how));
        JSONObject close=closed(id,10);
        check(close!=null&&expected.equals(close.getString("reason")),name);
        check(!request(new JSONObject().put("action","live").put("id",sid)).getBoolean("live"),name+"HostSessionGone");
        synchronized(delivered){int terminal=0;for(JSONObject v:delivered)if(id.equals(v.optString("id"))&&v.getString("kind").equals("close"))terminal++;check(terminal==1,name+"SingleTerminal");}
    }
    public static void main(String[] args) throws Exception {
        Process peer=null; AtomicBoolean active=new AtomicBoolean(true),running=new AtomicBoolean(true); Thread pumping=null;
        try {
            peer=new ProcessBuilder("node","--import","tsx","client/android/audit/real-hub-peer.mjs",args[1]).directory(new File(args[0])).redirectError(ProcessBuilder.Redirect.INHERIT).start();
            input=new BufferedWriter(new OutputStreamWriter(peer.getOutputStream(),"UTF-8"));output=new BufferedReader(new InputStreamReader(peer.getInputStream(),"UTF-8"));
            JSONObject network=new JSONObject(output.readLine());
            transport=new HubTransport(new HubTls(),e->{synchronized(events){events.add(e);events.notifyAll();}},active::get);
            String document=transport.document(); pumping=pump(running);

            String[] stopped=view(network,document,"stopped");
            // Past two Host pings and a pong deadline: an idle native session stays attached.
            Thread.sleep(20_000);
            check(closed(stopped[0],0)==null,"idleSurvivesHostHeartbeat");
            check(request(new JSONObject().put("action","live").put("id",stopped[1])).getBoolean("attached"),"idleHostStillAttached");
            ended(stopped[0],stopped[1],"stop","screen_stopped","hostStopKeepsReason");

            String[] expired=view(network,document,"expired");
            ended(expired[0],expired[1],"expire","session_expired","signInExpiryKeepsReason");

            String[] revoked=view(network,document,"revoked");
            ended(revoked[0],revoked[1],"revoke","device_revoked","deviceRevocationKeepsReason");

            receipt.put("surface","JVM production Android transport; real HubServer TLS listener, identity proof, screen sockets and heartbeat; synthetic target capture");
            Files.write(Paths.get(args[2]),receipt.toString(2).getBytes("UTF-8"));
        } finally {
            running.set(false); if(pumping!=null) pumping.interrupt();
            if(transport!=null) transport.close();
            if(peer!=null){try{input.write("{\"action\":\"stop\"}\n");input.flush();}catch(Exception ignored){} if(!peer.waitFor(10,TimeUnit.SECONDS))peer.destroyForcibly();}
        }
    }
}
