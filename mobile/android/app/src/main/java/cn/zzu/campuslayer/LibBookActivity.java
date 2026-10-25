package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 在壳内打开图书馆座位页，由页面自己完成「点座位 → 立即预约 → 确认」。
 * 这样 /v4/space/confirm 的 AES 加密由页面自己算，我们不碰密钥。
 */
public class LibBookActivity extends Activity {

    private WebView web;
    private String areaId = "3";
    private String date = "";
    private String seatNo = "";
    private boolean done = false;

    private String pageUrl() {
        return AppConfig.LIB_LOGIN_URL.replace("#/seat/index", "")
                + "#/seat/appointment?id=" + areaId + "&date=" + date;
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        areaId = getIntent().getStringExtra("areaId");
        if (areaId == null || areaId.isEmpty()) areaId = "3";
        date = getIntent().getStringExtra("date");
        if (date == null) date = "";
        seatNo = getIntent().getStringExtra("seatNo");
        if (seatNo == null) seatNo = "";

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUserAgentString(AppConfig.USER_AGENT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Hook(), "LibBookHook");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                // 页面每次路由变化都会再触发一次 onPageFinished（SPA 里不一定，所以配合定时重试）
                drive(0);
            }
        });
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.parseColor("#0b1220"));
        web.loadUrl(pageUrl());
    }

    /** 反复尝试驱动 DOM：座位出现 → 点它 → 点「立即预约」→ 点确认；都成功才回报。 */
    private void drive(final int round) {
        if (done || round > 24 || web == null) return;
        web.evaluateJavascript(BOOK_JS, null);
        web.postDelayed(new Runnable() {
            @Override public void run() { drive(round + 1); }
        }, 1200);
    }

    private final String BOOK_JS =
        "(function(){try{"
      + "if(window.__lbState==='done'){return 'done';}"
      + "var want=" + quoteJs(seatNo) + ";"
      + "var send=function(o){try{LibBookHook.report(JSON.stringify(o));}catch(e){}};"
      + "var vis=function(el){return !!(el&&el.offsetParent!==null);};"
      + "if(!window.__lbState){"
      + "  var cands=[].slice.call(document.querySelectorAll('div,span,text,image,use,button,a'));"
      + "  var seat=null;"
      + "  for(var i=0;i<cands.length;i++){var t=(cands[i].textContent||'').trim();"
      + "    if(t===want&&vis(cands[i])){seat=cands[i];break;}}"
      + "  if(!seat){return 'no-seat';}"
      + "  seat.click();window.__lbState='picked';return 'picked';}"
      + "if(window.__lbState==='picked'){"
      + "  var btns=[].slice.call(document.querySelectorAll('button,div,span,a'));"
      + "  for(var j=0;j<btns.length;j++){var bt=(btns[j].textContent||'').trim();"
      + "    if(/^立即预约$|^预\\s*约$|^确认预约$/.test(bt)&&vis(btns[j])){"
      + "      btns[j].click();window.__lbState='booked';return 'booked';}}"
      + "  return 'no-button';}"
      + "if(window.__lbState==='booked'){"
      + "  var body=document.body?document.body.innerText:'';"
      + "  if(/预约成功|已预约成功|预定成功/.test(body)){window.__lbState='done';send({ok:true,msg:'页面提示预约成功'});return 'ok';}"
      + "  var all=[].slice.call(document.querySelectorAll('button,div,span,a'));"
      + "  for(var k=0;k<all.length;k++){var tx=(all[k].textContent||'').trim();"
      + "    if(/^(确定|确认|同意|继续预约|我知道了)$/.test(tx)&&vis(all[k])){"
      + "      all[k].click();window.__lbState='confirming';return 'confirm';}}"
      + "  return 'no-confirm';}"
      + "if(window.__lbState==='confirming'){"
      + "  var b2=document.body?document.body.innerText:'';"
      + "  if(/预约成功|已预约成功|预定成功/.test(b2)){window.__lbState='done';send({ok:true,msg:'页面提示预约成功'});return 'ok';}"
      + "  return 'waiting';}"
      + "return 'idle';}catch(e){return 'err:'+e.message;}})()";

    private static String quoteJs(String v) {
        return "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private class Hook {
        @JavascriptInterface public void report(final String json) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (done) return;
                    done = true;
                    Intent out = new Intent();
                    out.putExtra("result", json);
                    setResult(RESULT_OK, out);
                    finish();
                }
            });
        }
    }

    @Override public boolean onCreateOptionsMenu(Menu m) {
        m.add(0, 1, 0, "重试");
        m.add(0, 2, 1, "取消");
        return true;
    }

    @Override public boolean onOptionsItemSelected(MenuItem it) {
        if (it.getItemId() == 1) {
            done = false;
            web.evaluateJavascript("window.__lbState=null", null);
            web.loadUrl(pageUrl());
            drive(0);
            return true;
        }
        if (it.getItemId() == 2) { finish(); return true; }
        return super.onOptionsItemSelected(it);
    }

    @Override public void onBackPressed() {
        // 不在这里放行，避免误以为已下单
        Toast.makeText(this, "返回会取消本次预约操作", Toast.LENGTH_SHORT).show();
        setResult(RESULT_CANCELED);
        finish();
    }
}
