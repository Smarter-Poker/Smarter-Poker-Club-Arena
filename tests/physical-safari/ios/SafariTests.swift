import XCTest
import UIKit
final class SafariTests: XCTestCase {
 let safari=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari")
 var fixture:[String:Any]=[:]
 var deadline:TimeInterval=0
 var stage="admission"
 func now()->TimeInterval {ProcessInfo.processInfo.systemUptime}
 func left(_ cap:Double)->Double {max(0,min(cap,deadline-now()))}
 func text(_ key:String)throws->String {try XCTUnwrap(fixture[key] as? String)}
 func http(_ path:String,body:Data?=nil)throws->[String:Any] {
  let base=try text("origin"); let u=try XCTUnwrap(URL(string:base+path));var r=URLRequest(url:u)
  r.timeoutInterval=left(5);r.cachePolicy = .reloadIgnoringLocalCacheData
  if let b=body {r.httpMethod="POST";r.httpBody=b;r.setValue("Fixture "+(try text("deviceStartTicket")),forHTTPHeaderField:"Authorization");r.setValue("application/json",forHTTPHeaderField:"Content-Type")}
  let sem=DispatchSemaphore(value:0);var result:Result<[String:Any],Error>?
  let task=URLSession.shared.dataTask(with:r){d,v,e in defer{sem.signal()};do {if let e=e{throw e};guard let h=v as? HTTPURLResponse,h.statusCode==200,let d=d else {throw NSError(domain:"owned_http_refused",code:1)};result = .success(try JSONSerialization.jsonObject(with:d)as! [String:Any])}catch{result = .failure(error)}}
  task.resume();guard sem.wait(timeout:.now()+left(5)) == .success else {task.cancel();throw NSError(domain:"owned_http_unknown_no_replay",code:1)}
  return try XCTUnwrap(result).get()
 }
 func named(_ pattern:String)->XCUIElement {safari.descendants(matching:.any).matching(NSPredicate(format:"label MATCHES[c] %@",pattern)).firstMatch}
 func tap(_ pattern:String,_ cap:Double=5)throws {let e=named(pattern);XCTAssertTrue(e.waitForExistence(timeout:left(cap)),"Required UI at "+stage);XCTAssertTrue(e.isHittable);e.tap()}
 func open(_ route:String)throws {
  safari.activate();XCTAssertEqual(safari.state,.runningForeground)
  let bar=safari.textFields.matching(NSPredicate(format:"identifier == %@ OR label CONTAINS[c] %@","URL","Address")).firstMatch
  XCTAssertTrue(bar.waitForExistence(timeout:left(5)));bar.tap();bar.typeText(try text("origin")+"/hub/club-arena/"+route+"\n")
 }
 func admit()throws {
  let raw=try XCTUnwrap(ProcessInfo.processInfo.environment["CA_OWNED_FIXTURE_JSON"]?.data(using:.utf8))
  fixture=try JSONSerialization.jsonObject(with:raw)as! [String:Any]
  XCTAssertEqual(try text("schema"),"isolated-funded-device/v1")
  let u=try XCTUnwrap(URLComponents(string:try text("origin")));XCTAssertEqual(u.scheme,"https");XCTAssertNil(u.user);XCTAssertNil(u.password)
  let host=try XCTUnwrap(u.host);XCTAssertFalse(["smarter.poker","engine.smarter.poker","ca-static.smarter.poker"].contains(host));XCTAssertFalse(host.hasSuffix(".supabase.co"))
  XCTAssertEqual(UIDevice.current.userInterfaceIdiom,.phone);XCTAssertEqual(UIDevice.current.systemName,"iOS")
  XCTAssertEqual(try text("platform"),"physical-ios-safari");XCTAssertTrue((try text("email")).hasSuffix("@smarter-poker.invalid"))
  for key in ["fullBFinishedSHA256","fullBTrialSHA256","fullBCleanupSHA256","servicesClosedSHA256","targetProofSHA256","fixtureAdmissionSHA256","ingressAdmissionSHA256"] {XCTAssertNotNil((try text(key)).range(of:"^[a-f0-9]{64}$",options:.regularExpression))}
  XCTAssertNotNil((try text("clientRevision")).range(of:"^[a-f0-9]{40}$",options:.regularExpression))
  XCTAssertNotNil((try text("tableId")).range(of:"^[a-f0-9-]{36}$",options:.regularExpression))
  let seat=try XCTUnwrap(fixture["seat"]as? Int);XCTAssertTrue((1...9).contains(seat))
  XCTAssertEqual(fixture["deviceSeconds"]as? Int,360);XCTAssertEqual(fixture["playerSeconds"]as? Int,240);XCTAssertEqual(fixture["measureSeconds"]as? Int,180)
 }
 func testSafariCapability()throws {
  continueAfterFailure=false;safari.launch();XCTAssertTrue(safari.wait(for:.runningForeground,timeout:20))
  XCTAssertEqual(safari.state,.runningForeground)
  // Provider admission and system-Safari foreground only. No funded/HTTPS verdict.
 }
 func testFundedPhysicalSafari()throws {
  continueAfterFailure=false;try admit();deadline=now()+360
  stage="start";let start=try JSONSerialization.data(withJSONObject:["runId":try text("runId"),"deviceModel":try text("deviceModel"),"requestId":try text("deviceStartRequestId")])
  _=try http("/fixture-device/start",body:start) // Exactly one request; unknown never replayed.
  let before=try http("/hub/club-arena/build-info.json");XCTAssertEqual(before["ca_sha"]as? String,try text("clientRevision"))
  stage="login";try open("auth")
  let email=safari.webViews.textFields.firstMatch;let password=safari.webViews.secureTextFields.firstMatch
  XCTAssertTrue(email.waitForExistence(timeout:left(20)));email.tap();email.typeText(try text("email"));XCTAssertTrue(password.exists);password.tap();password.typeText(try text("password"));try tap("Sign In")
  let loginEnd=now()+left(45)
  while email.exists && password.exists && now()<loginEnd {RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))}
  XCTAssertFalse(email.exists && password.exists,"Login must leave auth form")
  stage="table";try open("table/"+(try text("tableId")));let wall=now()+240,initial=now()+20
  let seat=try XCTUnwrap(fixture["seat"]as? Int);try tap(".*Seat "+String(seat)+": Open - Click To Sit.*",max(0,initial-now()))
  try tap("Buy In For The Minimum",max(0,initial-now()));try tap("Buy Chips",max(0,initial-now()))
  let play=min(wall,now()+180);var actions=0,reconnected=false
  while now()<play {
   let choices=[named("Check"),named("Call(?: [0-9,.]+)?"),named("Fold")]
   if let c=choices.first(where:{$0.exists && $0.isEnabled && $0.isHittable}) {
    c.tap();actions+=1
    let change=min(play,now()+10)
    while choices.contains(where:{$0.exists && $0.isEnabled}) && now()<change {RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))}
    XCTAssertFalse(choices.contains(where:{$0.exists && $0.isEnabled}),"Unknown action cannot be repeated")
    if actions==1 {safari.terminate();try open("table/"+(try text("tableId")));XCTAssertTrue(named(".*Table Menu.*").waitForExistence(timeout:min(20,max(0,play-now()))));reconnected=true}
   }
   RunLoop.current.run(until:Date(timeIntervalSinceNow:0.1))
  }
  XCTAssertGreaterThanOrEqual(actions,2);XCTAssertTrue(reconnected);XCTAssertLessThan(now(),wall)
  stage="ordinary-leave";try tap(".*Table Menu.*");try tap("Leave Table")
  XCTAssertTrue(named("Spectating|My Clubs").waitForExistence(timeout:min(20,max(0,wall-now()))))
  let after=try http("/hub/club-arena/build-info.json");XCTAssertEqual(after["ca_sha"]as? String,before["ca_sha"]as? String);XCTAssertLessThan(now(),wall)
  // Independent durable settlement/refund/wallet/escrow/supply proof remains required.
 }
}
