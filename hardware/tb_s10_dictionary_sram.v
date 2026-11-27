`timescale 1ns/1ps
module tb_s10_dictionary_sram;
 reg clk=0;always #5 clk=~clk;
 reg rst=1,we=0,commit=0,req=0;
 reg [9:0] ca=0,cv=0,a=0,b=0;
 wire configured,valid;wire [9:0] va,vb;
 s10_dictionary_sram dut(clk,rst,we,ca,cv,commit,configured,req,a,b,valid,va,vb);
 integer i;
 initial begin
  repeat(2)@(negedge clk);rst=0;commit=1;
  @(negedge clk);commit=0;if(configured)$fatal(1,"premature configuration");
  for(i=0;i<1024;i=i+1)begin we=1;ca=i;cv=i^10'h155;@(negedge clk);end
  we=0;commit=1;@(negedge clk);commit=0;
  if(!configured)$fatal(1,"configuration missing");
  for(i=0;i<1024;i=i+1)begin
   a=i;b=1023-i;req=1;@(posedge clk);#1;
   if(!valid||va!==(a^10'h155)||vb!==(b^10'h155))$fatal(1,"lookup mismatch");
   @(negedge clk);
  end
  req=0;@(posedge clk);#1;if(valid)$fatal(1,"unexpected valid");
  $display("1024 dual-port dictionary requests passed");$finish;
 end
endmodule
