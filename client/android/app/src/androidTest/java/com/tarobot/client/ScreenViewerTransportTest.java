package com.tarobot.client;

import static org.junit.Assert.*;
import android.content.Intent;
import android.os.ParcelFileDescriptor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Isolated application ID and synthetic pinned peer supplied by the runner.
 * Real Capacitor/WebView bridge + native pause/lock/destroy; never screen capture. */
@RunWith(AndroidJUnit4.class)
public class ScreenViewerTransportTest {
    private MainActivity activity;
    private String js(String expression) throws Exception {
        CountDownLatch done=new CountDownLatch(1); AtomicReference<String> value=new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.getBridge().getWebView().evaluateJavascript(expression,result->{value.set(result);done.countDown();}));
        assertTrue(done.await(10,TimeUnit.SECONDS)); return value.get();
    }
    private void waitFor(String expression) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(System.nanoTime()<until) {if("true".equals(js(expression)))return;Thread.sleep(50);}fail("WebView condition timed out: "+expression+"; state="+js("JSON.stringify(window.screenProbe)"));
    }
    private void shell(String command) throws Exception {try(ParcelFileDescriptor.AutoCloseInputStream stream=new ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))){while(stream.read()!=-1){}}}
    private void launch() throws Exception {
        var instrument=InstrumentationRegistry.getInstrumentation(); var intent=new Intent(instrument.getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if(activity==null) activity=(MainActivity)instrument.startActivitySync(intent);
        else { instrument.runOnMainSync(()->activity.startActivity(intent)); instrument.waitForIdleSync(); }
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
        while(System.nanoTime()<until) {var ready=new java.util.concurrent.atomic.AtomicBoolean();instrument.runOnMainSync(()->ready.set(activity.hasWindowFocus()&&((android.os.PowerManager)activity.getSystemService(android.content.Context.POWER_SERVICE)).isInteractive()&&!((android.app.KeyguardManager)activity.getSystemService(android.content.Context.KEYGUARD_SERVICE)).isKeyguardLocked()));if(ready.get())return;Thread.sleep(25);}fail("Activity did not resume with an unlocked foreground window");
    }
    private void open(int index) throws Exception {
        js("window.screenProbe={events:[],decoded:0,error:null,closed:0};window.fixture=JSON.parse(atob('"+InstrumentationRegistry.getArguments().getString("screenFixture")+"'));window.invokeScreen=(method,args)=>Capacitor.nativePromise('TaroCubHubTransport',method,args);void (async()=>{try{const d=await invokeScreen('document',{});window.screenDocument=d.value;Capacitor.addListener('TaroCubHubTransport','socket',e=>{screenProbe.events.push(e);if(e.kind==='close'){screenProbe.closed++;return;}void(async()=>{try{if(e.kind==='screen'){await invokeScreen('screenAck',{id:e.id,deliverySequence:e.deliverySequence});}else if(e.kind==='binary'){const parts=[];let offset=0;while(offset<e.byteLength){const v=await invokeScreen('screenRead',{id:e.id,deliverySequence:e.deliverySequence,offset,maxBytes:262144});const b=Uint8Array.from(atob(v.data),c=>c.charCodeAt(0));parts.push(b);offset+=b.length;}const bytes=new Uint8Array(offset);let n=0;for(const p of parts){bytes.set(p,n);n+=p.length;}const decoder=new VideoDecoder({output:frame=>{const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');ctx.drawImage(frame,0,0);screenProbe.pixel=Array.from(ctx.getImageData(32,32,1,1).data);screenProbe.decoded++;frame.close();},error:e=>screenProbe.error=String(e)});decoder.configure({codec:'avc1.42c01e',codedWidth:64,codedHeight:64,optimizeForLatency:true});decoder.decode(new EncodedVideoChunk({type:'key',timestamp:0,data:bytes.subarray(32)}));await decoder.flush();decoder.close();await invokeScreen('screenAck',{id:e.id,deliverySequence:e.deliverySequence});}}catch(e){screenProbe.error=String(e);}})();});const a=await invokeScreen('allocate',{kind:'screen',document:d.value});window.screenId=a.value;window.screenJoin=fixture.joins["+index+"];await invokeScreen('screenOpen',{id:screenId,network:fixture.network,join:screenJoin});}catch(e){screenProbe.error=String(e);}})()");
        waitFor("screenProbe.decoded===1&&screenProbe.error===null");
        assertEquals("red decoded frame", "true",js("screenProbe.pixel[0]>200&&screenProbe.pixel[1]<30&&screenProbe.pixel[2]<30"));
    }
    @Test public void pinnedBinaryDecodeAndNativeLifecycle() throws Exception {
        assertNotNull("private synthetic fixture required",InstrumentationRegistry.getArguments().getString("screenFixture"));
        assertTrue("never use the daily App",InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName().startsWith("test.tarobird."));
        shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard");launch();waitFor("typeof Capacitor!=='undefined'");
        try {
            open(0);
            js("void invokeScreen('screenSend',{id:screenId,command:{type:'control',sessionId:screenJoin.session.id,generation:screenJoin.session.generation,frameSequence:1}}).catch(e=>screenProbe.error=String(e))");
            waitFor("screenProbe.events.some(e=>e.value?.lease)&&screenProbe.error===null");
            js("window.focusGate={};void(async()=>{const base={sessionId:screenJoin.session.id,generation:screenJoin.session.generation};const renew={type:'renew',...base,leaseId:'L'.repeat(43),challenge:'C'.repeat(43),frameSequence:1};const input={type:'input',...base,desktopId:screenJoin.session.desktopId,displayId:screenJoin.session.display.id,displayRevision:1,leaseId:'L'.repeat(43),sequence:1,frameSequence:1,expiresAt:Date.now()+1000,event:{kind:'move',x:0.5,y:0.5}};const send=command=>invokeScreen('screenSend',{id:screenId,command});try{await send(renew)}catch{focusGate.initialDenied=true}await send({type:'input-focus',...base,enabled:true});await send(renew);await send(input);await send({type:'input-focus',...base,enabled:false});try{await send(renew)}catch{focusGate.renewDenied=true}try{await send(input)}catch{focusGate.inputDenied=true}focusGate.done=true;})().catch(e=>screenProbe.error=String(e))");
            waitFor("focusGate.done&&focusGate.initialDenied&&focusGate.renewDenied&&focusGate.inputDenied&&screenProbe.error===null");
            shell("input keyevent KEYCODE_HOME");Thread.sleep(350);launch();waitFor("screenProbe.closed===1");
            js("window.oldDenied=false;void invokeScreen('screenSend',{id:screenId,command:{type:'keyframe',sessionId:screenJoin.session.id,generation:screenJoin.session.generation}}).catch(()=>window.oldDenied=true)");waitFor("window.oldDenied===true");
            open(1);shell("input keyevent KEYCODE_SLEEP");Thread.sleep(350);shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard");launch();waitFor("screenProbe.closed===1");
            js("window.lockOldDenied=false;void invokeScreen('screenSend',{id:screenId,command:{type:'keyframe',sessionId:screenJoin.session.id,generation:screenJoin.session.generation}}).catch(()=>window.lockOldDenied=true)");waitFor("window.lockOldDenied===true");
            open(2);Thread.sleep(600);assertEquals("new explicit viewer survives a delayed screen-off broadcast","true",js("screenProbe.decoded===1&&screenProbe.closed===0"));InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.finishAndRemoveTask());
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);while(!activity.isDestroyed()&&System.nanoTime()<until)Thread.sleep(50);assertTrue("Activity destruction completed",activity.isDestroyed());
        } finally {if(activity!=null&&!activity.isDestroyed())InstrumentationRegistry.getInstrumentation().runOnMainSync(()->activity.finishAndRemoveTask());}
    }
}
