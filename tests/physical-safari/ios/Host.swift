import UIKit
@main final class AcceptanceHost: UIResponder, UIApplicationDelegate {
 var window: UIWindow?
 func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey:Any]?) -> Bool {
  let w=UIWindow(frame: UIScreen.main.bounds); let c=UIViewController(); c.view.backgroundColor = .black
  w.rootViewController=c;w.makeKeyAndVisible();window=w;return true
 }
}
