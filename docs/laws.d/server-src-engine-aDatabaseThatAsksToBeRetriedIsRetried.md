# server/src/engine/aDatabaseThatAsksToBeRetriedIsRetried.law.test.ts

A Database That Asks To Be Retried Is Retried: A Postgres Serialization Failure Is The Database Blinking And Not The Code Being Wrong, So It Is Recognised As Transient And The Hand Record Is Given A Bounded Budget To Try Again, While Every Refusal The Database Gives On Purpose Stays A Decision And Not A Queue.
