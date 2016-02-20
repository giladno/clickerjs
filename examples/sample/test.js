function test1(a){
    return a+1;
}
function test2(a){
    return test1(a)+10;
}
function test3(a){
    return test2(a)+100;
}

var a = test3(1);
console.log(a);

